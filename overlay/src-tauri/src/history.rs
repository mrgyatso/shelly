//! The history HUD's data layer: enumerate past artifacts and re-open one.
//!
//! Artifacts are loose `*.html` files in the artifacts dir — there is no index
//! or manifest — so [`list_artifacts`] derives everything (title, date, size)
//! from the filesystem on demand. The HUD window itself lives in
//! [`crate::windows::open_history_window`].

use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use tauri::{AppHandle, Manager};

/// Cap how much of each file we read to find its `<title>` / metadata — both
/// live in the `<head>`, so a few KB is plenty and a multi-MB artifact can't
/// stall the list.
const HEAD_SCAN_BYTES: usize = 16 * 1024;

/// One past artifact, as surfaced to the HUD grid.
#[derive(serde::Serialize)]
pub struct ArtifactEntry {
    /// Absolute path, used as the re-open key.
    pub path: String,
    /// Parsed `<title>`, falling back to a humanized filename.
    pub title: String,
    /// Optional `subject` from the artifact's `companion-meta` block.
    pub subject: Option<String>,
    /// Optional `summary` from the artifact's `companion-meta` block — shown as
    /// the card subtitle so artifacts are distinguishable at a glance.
    pub summary: Option<String>,
    /// Last-modified time as epoch milliseconds — drives the date label + sort.
    pub modified_ms: u64,
    pub size_bytes: u64,
}

/// The subset of the `companion-meta` JSON block the HUD surfaces. Other fields
/// (files, project, branch, created) are for the feedback payload, not the card,
/// so serde simply ignores them.
#[derive(serde::Deserialize)]
struct CompanionMeta {
    subject: Option<String>,
    summary: Option<String>,
}

/// Candidate artifact directories, most-authoritative first.
///
/// The daemon is normally launched by a LaunchAgent, which does NOT inherit a
/// shell `COMPANION_ARTIFACTS_DIR`, so we also probe the well-known default
/// (`~/.claude/companion/artifacts`) and keep it if it exists — otherwise the
/// HUD would be empty on the exact machines that have artifacts.
fn artifact_dirs() -> Vec<PathBuf> {
    let mut dirs: Vec<PathBuf> = Vec::new();
    if let Some(env) = std::env::var_os("COMPANION_ARTIFACTS_DIR") {
        dirs.push(PathBuf::from(env));
    }
    if let Some(home) = std::env::var_os("HOME") {
        let home = Path::new(&home);
        dirs.push(home.join(".claude/companion/artifacts"));
        // Artifacts pulled from a remote hub (offsite agents) land here.
        dirs.push(home.join(".claude/companion/remote"));
        dirs.push(home.join("codeviz/public/artifacts"));
    }
    dirs.retain(|d| d.is_dir());
    dirs.dedup();
    dirs
}

/// `foo-bar_baz.html` → `Foo Bar Baz`. Used when an artifact has no `<title>`.
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

/// Pull the trimmed contents of the first `<title>…</title>` from `html`,
/// case-insensitively. Returns `None` if absent or empty.
fn extract_title(html: &str) -> Option<String> {
    let lower = html.to_ascii_lowercase();
    let open = lower.find("<title")?;
    // Skip to the end of the opening tag (handles `<title>` and `<title ...>`).
    let gt = lower[open..].find('>')? + open + 1;
    let close = lower[gt..].find("</title>")? + gt;
    let title = html[gt..close].trim();
    if title.is_empty() {
        None
    } else {
        Some(title.to_string())
    }
}

/// Parse the `<script type="application/json" id="companion-meta">…</script>`
/// block (if present) for the card subtitle. Returns the deserialized subset, or
/// `None` if the block is absent or malformed — a bad block never sinks the card.
fn extract_meta(html: &str) -> Option<CompanionMeta> {
    let lower = html.to_ascii_lowercase();
    let id = lower.find("id=\"companion-meta\"")?;
    // The opening <script ...> tag ends at the next '>' after the id attribute.
    let gt = lower[id..].find('>')? + id + 1;
    let close = lower[gt..].find("</script>")? + gt;
    serde_json::from_str(html[gt..close].trim()).ok()
}

/// Read one directory entry into an [`ArtifactEntry`], or `None` to skip it
/// (not an `.html`, scaffolding, or unreadable). Never panics — a single bad
/// file must not sink the whole listing.
fn entry_from_path(path: &Path) -> Option<ArtifactEntry> {
    let ext = path.extension()?.to_str()?.to_ascii_lowercase();
    if ext != "html" && ext != "htm" {
        return None;
    }
    let stem = path.file_stem()?.to_str()?;
    // Skip `_diag-*.html` and similar scaffolding the repo leaves in the dir.
    if stem.starts_with('_') {
        return None;
    }

    let meta = std::fs::metadata(path).ok()?;
    let modified_ms = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);

    // Read only the head of the file once for both the title and the metadata
    // block — cheap even across many files.
    let head = read_head(path, HEAD_SCAN_BYTES);
    let title = head
        .as_deref()
        .and_then(extract_title)
        .unwrap_or_else(|| humanize_filename(stem));
    let cmeta = head.as_deref().and_then(extract_meta);
    let (subject, summary) = match cmeta {
        Some(m) => (m.subject, m.summary),
        None => (None, None),
    };

    Some(ArtifactEntry {
        path: path.to_string_lossy().into_owned(),
        title,
        subject,
        summary,
        modified_ms,
        size_bytes: meta.len(),
    })
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

/// Every past artifact across the candidate dirs, newest first. Returns a `Vec`
/// (not a `Result`) so a partial filesystem failure still yields a usable grid.
#[tauri::command]
pub fn list_artifacts() -> Vec<ArtifactEntry> {
    let mut entries: Vec<ArtifactEntry> = artifact_dirs()
        .iter()
        .filter_map(|dir| std::fs::read_dir(dir).ok())
        .flatten()
        .filter_map(|e| e.ok())
        .filter_map(|e| entry_from_path(&e.path()))
        .collect();
    entries.sort_by_key(|e| std::cmp::Reverse(e.modified_ms));
    entries
}

/// Re-open an artifact as a normal panel and dismiss the HUD. The HUD is hidden
/// (not closed) so the next ⌘8 re-shows it warm without rebuilding.
#[tauri::command]
pub fn reopen_artifact(app: AppHandle, path: String) {
    crate::windows::open_artifact_window(&app, path);
    if let Some(hud) = app.get_webview_window(crate::windows::HISTORY_LABEL) {
        let _ = hud.hide();
    }
}
