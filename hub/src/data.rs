//! The hub's read-only data layer: surface the same on-disk live-state and
//! artifact files the local overlay reads, over HTTP.
//!
//! This deliberately mirrors the overlay's `live.rs::read_live` (newest
//! per-project `*.json` wins) and `history.rs::list_artifacts` (derive title +
//! `shelly-meta` from each `*.html`'s `<head>`). The logic is duplicated
//! rather than shared so the hub stays a small standalone binary with no Tauri
//! dependency — easy to drop on a VPS.

use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

/// Cap how much of each artifact we read to find its `<title>` / metadata — both
/// live in the `<head>`, so a few KB is plenty and a multi-MB artifact can't
/// stall the listing.
const HEAD_SCAN_BYTES: usize = 16 * 1024;

/// One artifact, as surfaced by `GET /api/artifacts`. `slug` is the filename
/// stem (the `GET /api/artifacts/<slug>` key); the rest mirror the overlay's
/// `ArtifactEntry` plus `project`/`created` from the `shelly-meta` block.
#[derive(serde::Serialize)]
pub struct ArtifactEntry {
    pub slug: String,
    pub title: String,
    pub subject: Option<String>,
    pub summary: Option<String>,
    pub project: Option<String>,
    pub created: Option<String>,
    pub modified_ms: u64,
    pub size_bytes: u64,
}

/// The subset of the `shelly-meta` JSON block the hub surfaces. Unknown
/// fields are ignored by serde.
#[derive(serde::Deserialize)]
struct ShellyMeta {
    subject: Option<String>,
    summary: Option<String>,
    project: Option<String>,
    created: Option<String>,
}

#[derive(serde::Serialize, serde::Deserialize, Clone, Debug, PartialEq)]
pub struct RoutineState {
    pub id: String,
    pub completed: bool,
    pub updated_ms: u64,
    pub title: Option<String>,
    pub notes: Option<String>,
    pub bucket: Option<String>,
    pub completed_at: Option<String>,
    pub due_at: Option<String>,
    pub meta: Option<serde_json::Map<String, serde_json::Value>>,
}

#[derive(serde::Deserialize, Clone, Debug, PartialEq)]
pub struct RoutineUpsert {
    #[serde(default)]
    pub completed: bool,
    pub title: Option<String>,
    pub notes: Option<String>,
    pub bucket: Option<String>,
    pub completed_at: Option<String>,
    pub due_at: Option<String>,
    pub meta: Option<serde_json::Map<String, serde_json::Value>>,
}

#[derive(Debug, PartialEq)]
pub enum WriteRoutineError {
    InvalidId,
    Io(String),
}

/// A filesystem-safe slug: a bare filename stem, no path separators or `..`, so
/// it can never escape its directory. Returns the borrowed slug if valid.
pub fn safe_slug(slug: &str) -> Option<&str> {
    if slug.is_empty() || slug.len() > 200 {
        return None;
    }
    let ok = slug
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.');
    if ok && slug != "." && slug != ".." {
        Some(slug)
    } else {
        None
    }
}

/// Epoch-millis mtime of a path, or `0` if unavailable.
pub(crate) fn modified_ms(meta: &std::fs::Metadata) -> u64 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

pub(crate) fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

// ----- live state -------------------------------------------------------------

/// The most-recently-modified `*.json` directly under `dir`, if any.
fn newest_json(dir: &Path) -> Option<PathBuf> {
    let mut newest: Option<(std::time::SystemTime, PathBuf)> = None;
    for entry in std::fs::read_dir(dir).ok()?.flatten() {
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

/// The newest live-state object (or the one named by `project`), with the file's
/// mtime injected as `updated_ms`. Returns `{}` when nothing is present or the
/// requested project is missing/invalid. A malformed file also yields `{}` so a
/// bad write never sinks the endpoint.
pub fn read_live(live_dir: &Path, project: Option<&str>) -> serde_json::Value {
    let path = match project {
        Some(p) => match safe_slug(p) {
            Some(slug) => live_dir.join(format!("{slug}.json")),
            None => return serde_json::json!({}),
        },
        None => match newest_json(live_dir) {
            Some(p) => p,
            None => return serde_json::json!({}),
        },
    };

    let updated_ms = std::fs::metadata(&path)
        .map(|m| modified_ms(&m))
        .unwrap_or(0);
    let mut value: serde_json::Value = match std::fs::read_to_string(&path) {
        Ok(raw) => serde_json::from_str(&raw).unwrap_or_else(|_| serde_json::json!({})),
        Err(_) => return serde_json::json!({}),
    };
    if let Some(obj) = value.as_object_mut() {
        obj.insert("updated_ms".into(), serde_json::json!(updated_ms));
    }
    value
}

// ----- routines ---------------------------------------------------------------

fn routine_path(routines_dir: &Path, id: &str) -> Option<PathBuf> {
    Some(routines_dir.join(format!("{}.json", safe_slug(id)?)))
}

pub fn read_routine(routines_dir: &Path, id: &str) -> Option<RoutineState> {
    let path = routine_path(routines_dir, id)?;
    let raw = std::fs::read_to_string(path).ok()?;
    serde_json::from_str(&raw).ok()
}

pub fn list_routines(routines_dir: &Path) -> Vec<RoutineState> {
    let mut entries: Vec<RoutineState> = std::fs::read_dir(routines_dir)
        .into_iter()
        .flatten()
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .filter(|path| path.extension().and_then(|e| e.to_str()) == Some("json"))
        .filter_map(|path| std::fs::read_to_string(path).ok())
        .filter_map(|raw| serde_json::from_str::<RoutineState>(&raw).ok())
        .collect();
    entries.sort_by_key(|entry| std::cmp::Reverse(entry.updated_ms));
    entries
}

pub fn write_routine(
    routines_dir: &Path,
    id: &str,
    input: RoutineUpsert,
) -> Result<RoutineState, WriteRoutineError> {
    let id = safe_slug(id).ok_or(WriteRoutineError::InvalidId)?;
    let path = routine_path(routines_dir, id).ok_or(WriteRoutineError::InvalidId)?;
    std::fs::create_dir_all(routines_dir)
        .map_err(|e| WriteRoutineError::Io(format!("create routines dir: {e}")))?;
    let routine = RoutineState {
        id: id.to_string(),
        completed: input.completed,
        updated_ms: now_ms(),
        title: input.title,
        notes: input.notes,
        bucket: input.bucket,
        completed_at: input.completed_at,
        due_at: input.due_at,
        meta: input.meta,
    };
    let json = serde_json::to_string_pretty(&routine)
        .map_err(|e| WriteRoutineError::Io(format!("serialize routine: {e}")))?;
    std::fs::write(&path, json)
        .map_err(|e| WriteRoutineError::Io(format!("write routine file: {e}")))?;
    Ok(routine)
}

// ----- artifacts --------------------------------------------------------------

/// `foo-bar_baz` → `Foo Bar Baz`. Used when an artifact has no `<title>`.
fn humanize_filename(stem: &str) -> String {
    let mut out = String::with_capacity(stem.len());
    let mut at_word_start = true;
    for ch in stem.chars() {
        if ch == '-' || ch == '_' {
            out.push(' ');
            at_word_start = true;
        } else if at_word_start {
            out.extend(ch.to_uppercase());
            at_word_start = false;
        } else {
            out.push(ch);
        }
    }
    out
}

/// Trimmed contents of the first `<title>…</title>`, case-insensitively.
fn extract_title(html: &str) -> Option<String> {
    let lower = html.to_ascii_lowercase();
    let open = lower.find("<title")?;
    let gt = lower[open..].find('>')? + open + 1;
    let close = lower[gt..].find("</title>")? + gt;
    let title = html[gt..close].trim();
    if title.is_empty() {
        None
    } else {
        Some(title.to_string())
    }
}

/// Parse the `shelly-meta` JSON block, or `None` if absent/malformed.
fn extract_meta(html: &str) -> Option<ShellyMeta> {
    let lower = html.to_ascii_lowercase();
    let id = lower.find("id=\"shelly-meta\"")?;
    let gt = lower[id..].find('>')? + id + 1;
    let close = lower[gt..].find("</script>")? + gt;
    serde_json::from_str(html[gt..close].trim()).ok()
}

/// Read up to `limit` bytes of a file as lossy UTF-8. `None` on read failure.
fn read_head(path: &Path, limit: usize) -> Option<String> {
    use std::io::Read;
    let mut f = std::fs::File::open(path).ok()?;
    let mut buf = vec![0u8; limit];
    let n = f.read(&mut buf).ok()?;
    buf.truncate(n);
    Some(String::from_utf8_lossy(&buf).into_owned())
}

/// Read one directory entry into an [`ArtifactEntry`], or `None` to skip it
/// (not an `.html`, scaffolding, or unreadable). Never panics — one bad file
/// must not sink the whole listing.
fn entry_from_path(path: &Path) -> Option<ArtifactEntry> {
    let ext = path.extension()?.to_str()?.to_ascii_lowercase();
    if ext != "html" && ext != "htm" {
        return None;
    }
    let stem = path.file_stem()?.to_str()?;
    // Skip `_diag-*.html` and similar scaffolding left in the dir.
    if stem.starts_with('_') {
        return None;
    }

    let meta = std::fs::metadata(path).ok()?;
    let head = read_head(path, HEAD_SCAN_BYTES);
    let title = head
        .as_deref()
        .and_then(extract_title)
        .unwrap_or_else(|| humanize_filename(stem));
    let cmeta = head.as_deref().and_then(extract_meta);
    let (subject, summary, project, created) = match cmeta {
        Some(m) => (m.subject, m.summary, m.project, m.created),
        None => (None, None, None, None),
    };

    Some(ArtifactEntry {
        slug: stem.to_string(),
        title,
        subject,
        summary,
        project,
        created,
        modified_ms: modified_ms(&meta),
        size_bytes: meta.len(),
    })
}

/// Every artifact in `artifacts_dir`, newest first.
pub fn list_artifacts(artifacts_dir: &Path) -> Vec<ArtifactEntry> {
    let mut entries: Vec<ArtifactEntry> = std::fs::read_dir(artifacts_dir)
        .into_iter()
        .flatten()
        .filter_map(|e| e.ok())
        .filter_map(|e| entry_from_path(&e.path()))
        .collect();
    entries.sort_by_key(|e| std::cmp::Reverse(e.modified_ms));
    entries
}

/// The raw bytes of `<artifacts_dir>/<slug>.html`, with a path-traversal guard.
/// `None` if the slug is unsafe or the file is missing/unreadable.
pub fn read_artifact(artifacts_dir: &Path, slug: &str) -> Option<Vec<u8>> {
    let slug = safe_slug(slug)?;
    let path = artifacts_dir.join(format!("{slug}.html"));
    std::fs::read(path).ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn temp_path(name: &str) -> PathBuf {
        let unique = format!(
            "shelly-hub-test-{}-{}-{}",
            name,
            std::process::id(),
            now_ms()
        );
        std::env::temp_dir().join(unique)
    }

    #[test]
    fn rejects_traversal_slugs() {
        assert!(safe_slug("..").is_none());
        assert!(safe_slug("../etc/passwd").is_none());
        assert!(safe_slug("a/b").is_none());
        assert!(safe_slug("").is_none());
        assert_eq!(safe_slug("good-slug_1.2"), Some("good-slug_1.2"));
    }

    #[test]
    fn writes_and_reads_routine_state() {
        let dir = temp_path("routine-read-write");
        let mut meta = serde_json::Map::new();
        meta.insert("source".into(), serde_json::json!("telegram"));
        let created = write_routine(
            &dir,
            "morning-briefing",
            RoutineUpsert {
                completed: false,
                title: Some("Morning briefing".into()),
                notes: Some("Missed before commute".into()),
                bucket: Some("daily-rhythm".into()),
                completed_at: None,
                due_at: Some("2026-06-17".into()),
                meta: Some(meta.clone()),
            },
        )
        .unwrap();

        assert_eq!(created.id, "morning-briefing");
        assert!(!created.completed);
        assert!(created.updated_ms > 0);
        assert_eq!(created.meta, Some(meta));

        let loaded = read_routine(&dir, "morning-briefing").unwrap();
        assert_eq!(loaded, created);

        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn lists_routines_newest_first() {
        let dir = temp_path("routine-list");
        let first = write_routine(
            &dir,
            "morning-briefing",
            RoutineUpsert {
                completed: true,
                title: None,
                notes: None,
                bucket: None,
                completed_at: Some("2026-06-17T08:40:00-04:00".into()),
                due_at: None,
                meta: None,
            },
        )
        .unwrap();
        std::thread::sleep(std::time::Duration::from_millis(2));
        let second = write_routine(
            &dir,
            "eod-work",
            RoutineUpsert {
                completed: false,
                title: None,
                notes: None,
                bucket: Some("shutdown".into()),
                completed_at: None,
                due_at: Some("2026-06-17".into()),
                meta: None,
            },
        )
        .unwrap();

        let routines = list_routines(&dir);
        assert_eq!(routines.len(), 2);
        assert_eq!(routines[0].id, second.id);
        assert_eq!(routines[1].id, first.id);

        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn rejects_invalid_routine_ids() {
        let dir = temp_path("routine-invalid");
        let err = write_routine(
            &dir,
            "../../bad",
            RoutineUpsert {
                completed: false,
                title: None,
                notes: None,
                bucket: None,
                completed_at: None,
                due_at: None,
                meta: None,
            },
        )
        .unwrap_err();
        assert_eq!(err, WriteRoutineError::InvalidId);
        assert!(read_routine(&dir, "../../bad").is_none());
    }

    #[test]
    fn humanizes_stems() {
        assert_eq!(humanize_filename("foo-bar_baz"), "Foo Bar Baz");
    }

    #[test]
    fn extracts_title_and_meta() {
        let html = r#"<html><head><title>Hello</title>
            <script type="application/json" id="shelly-meta">
            {"subject":"S","summary":"Sum","project":"P","created":"2026-06-09"}
            </script></head><body>x</body></html>"#;
        assert_eq!(extract_title(html).as_deref(), Some("Hello"));
        let m = extract_meta(html).unwrap();
        assert_eq!(m.subject.as_deref(), Some("S"));
        assert_eq!(m.project.as_deref(), Some("P"));
    }
}
