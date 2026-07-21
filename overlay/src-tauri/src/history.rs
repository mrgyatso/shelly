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
    /// Optional `subject` from the artifact's `shelly-meta` block.
    pub subject: Option<String>,
    /// Optional `summary` from the artifact's `shelly-meta` block — shown as
    /// the card subtitle so artifacts are distinguishable at a glance.
    pub summary: Option<String>,
    /// Last-modified time as epoch milliseconds — drives the date label + sort.
    pub modified_ms: u64,
    pub size_bytes: u64,
    /// Raw `project` from the `shelly-meta` block — the artifact's source
    /// (often a path like `~/shelly`). The Board groups artifacts
    /// into per-agent panes by matching this against each pane's source slug.
    pub project: Option<String>,
    /// AUTHORITATIVE unit key, written at create time by the shelly-hook (keyed
    /// on the writing session's `session_id`, resolved from its live file — not the
    /// volatile cwd). Present ⇒ the Board routes by it directly and `project` is
    /// display-only; absent ⇒ the Board falls back to project-slug matching.
    pub unit_key: Option<String>,
    /// The writing session's source slug (`<slug>--<shortid>`), from the routing
    /// index. Lets the Board send an artifact's ✓/✎/✗ answer to the EXACT session
    /// that produced it (a unit can hold several owned sessions).
    pub source: Option<String>,
    /// The writing session's FULL `session_id`, from the routing index. The key into
    /// the identity registry: present ⇒ `unit_key` above was resolved authoritatively
    /// from `sessions/<session_id>.json` (no staleness guard); absent ⇒ a pre-registry
    /// artifact that fell back to the index/slug derivation. Lets the Board label the
    /// routing path in the trace.
    pub session_id: Option<String>,
}

/// The subset of the `shelly-meta` JSON block the HUD + Board surface. Other
/// fields (files, branch, created) are for the feedback payload, not the card,
/// so serde simply ignores them.
#[derive(serde::Deserialize)]
struct ShellyMeta {
    subject: Option<String>,
    summary: Option<String>,
    /// The artifact's source — used by the Board to route it to a pane.
    project: Option<String>,
}

/// Candidate artifact directories, most-authoritative first.
///
/// The daemon is normally launched by a LaunchAgent, which does NOT inherit a
/// shell `SHELLY_ARTIFACTS_DIR`, so we also probe the well-known default
/// (`~/.shelly/artifacts`) and keep it if it exists — otherwise the
/// HUD would be empty on the exact machines that have artifacts.
pub(crate) fn artifact_dirs() -> Vec<PathBuf> {
    let mut dirs: Vec<PathBuf> = Vec::new();
    if let Some(env) = std::env::var_os("SHELLY_ARTIFACTS_DIR") {
        dirs.push(PathBuf::from(env));
    }
    if let Some(home) = std::env::var_os("HOME") {
        let home = Path::new(&home);
        dirs.push(home.join(".shelly/artifacts"));
        // Artifacts pulled from a remote hub (offsite agents) land here.
        dirs.push(home.join(".shelly/remote"));
        dirs.push(home.join("codeviz/public/artifacts"));
    }
    dirs.retain(|d| d.is_dir());
    dirs.dedup();
    dirs
}

/// Unit key stamped onto remote/hub-pulled artifacts so they route to first-class
/// Board units instead of sinking into Unsourced. An artifact whose shelly-meta
/// carries a slug-safe `project` (the connected agent's id — e.g. `hermes`) gets a
/// per-agent unit `__cloud__:<agent>`; anything unattributed gets the bare key.
/// Kept in sync with the `CLOUD` sentinel in `board.ts`. Assigned here (not in the
/// board.ts routing resolver) so the identity/routing logic stays untouched.
const CLOUD_UNIT_KEY: &str = "__cloud__";

/// True when a remote artifact's `project` can serve as a per-agent unit suffix
/// (same alphabet as the hub's `safe_slug` — never a path, never `..`).
fn is_agent_slug(project: &str) -> bool {
    !project.is_empty()
        && project.len() <= 200
        && project != "."
        && project != ".."
        && project
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.')
}

/// The dir hub-pulled artifacts land in (`~/.shelly/remote`). An entry
/// under it is a remote artifact with no local index identity.
fn remote_artifacts_dir() -> Option<PathBuf> {
    crate::paths::shelly_dir().map(|d| d.join("remote"))
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

/// Parse the `<script type="application/json" id="shelly-meta">…</script>`
/// block (if present) for the card subtitle. Returns the deserialized subset, or
/// `None` if the block is absent or malformed — a bad block never sinks the card.
fn extract_meta(html: &str) -> Option<ShellyMeta> {
    let lower = html.to_ascii_lowercase();
    let id = lower.find("id=\"shelly-meta\"")?;
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
    // `home.html` is the agent-authored L0 Hub dashboard, and `home.<unit>.html`
    // are the per-unit L2 home digests — agent-authored reserved surfaces, not
    // one-off artifacts. They live in the artifacts dir (so their JS runs in
    // asset: scope) but must not surface as a history row in ANY unit. Both the
    // History HUD and the Board's history list read `list_artifacts`, so this one
    // skip covers both. (file_stem strips only `.html`, so `home.<unit>.html`
    // yields stem `home.<unit>` → caught by the prefix.)
    if stem == "home" || stem.starts_with("home.") {
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
    let (subject, summary, project) = match cmeta {
        Some(m) => (m.subject, m.summary, m.project),
        None => (None, None, None),
    };

    Some(ArtifactEntry {
        path: path.to_string_lossy().into_owned(),
        title,
        subject,
        summary,
        modified_ms,
        size_bytes: meta.len(),
        project,
        // Attached after the fact in `list_artifacts` from the index, so a single
        // index read covers the whole listing rather than re-reading per file.
        unit_key: None,
        source: None,
        session_id: None,
    })
}

/// One routing-index entry, as read off disk. `unit_key` + `source` are the stamped
/// routing; `session_id` is the link into the identity registry (present on every
/// entry stamped by routeArtifact; absent only on legacy pre-registry entries).
struct IndexEntry {
    unit_key: String,
    source: Option<String>,
    /// Full writing-session id; `Some` ⇒ resolve `unit_key` authoritatively via the
    /// registry, `None` ⇒ trust the stamped `unit_key` (legacy entry).
    session_id: Option<String>,
    /// When the writing session's Stop hook SEALED this artifact — "the agent stopped
    /// writing; you may show it". `None` ⇒ still being authored, so the listing withholds
    /// it (see `is_settled`). Absent on entries from a pre-seal plugin, which
    /// `is_settled`'s backstop covers.
    sealed_ms: Option<u64>,
    /// When the entry was last stamped (every write re-stamps it). Feeds the backstop
    /// that releases an artifact whose session died before it could seal.
    ts: Option<u64>,
}

/// How long an UNSEALED artifact is withheld before the listing shows it anyway.
///
/// The seal is the real signal; this is the backstop for the session that never reaches
/// another Stop at all — killed, crashed, or a provider whose harness has no Stop hook.
/// Without it those artifacts would be withheld forever, which is a far worse failure
/// than the mid-build churn the seal prevents.
///
/// Long on purpose. A turn that runs 20 minutes is unremarkable, and every minute below
/// this is a minute of real turns leaking their half-built artifacts back onto the Board.
/// Interrupted turns don't need it (the session's NEXT Stop sweeps them up — see
/// `sealArtifacts`), so this only has to catch the session that never comes back.
const SETTLE_BACKSTOP_MS: u64 = 15 * 60 * 1000;

/// The hook-written routing index: `abs-path → IndexEntry`. Lives next to the live dir at
/// `~/.shelly/artifact-index.json`, shape
/// `{ "<abs-path>.html": { "unit_key", "shortid", "source", "ts", "session_id" }, ... }`.
/// (Older entries may still be keyed by basename and/or lack `session_id`; `list_artifacts`
/// falls back to that.) Returns an empty map on any failure — routing then falls back to
/// project-slug.
fn load_artifact_index() -> std::collections::HashMap<String, IndexEntry> {
    let mut map = std::collections::HashMap::new();
    let Some(home) = std::env::var_os("HOME") else {
        return map;
    };
    let path = Path::new(&home).join(".shelly/artifact-index.json");
    let Ok(text) = std::fs::read_to_string(&path) else {
        return map;
    };
    let Ok(json) = serde_json::from_str::<serde_json::Value>(&text) else {
        return map;
    };
    if let Some(obj) = json.as_object() {
        for (name, entry) in obj {
            if let Some(unit) = entry.get("unit_key").and_then(|v| v.as_str()) {
                let source = entry
                    .get("source")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string());
                let session_id = entry
                    .get("session_id")
                    .and_then(|v| v.as_str())
                    .filter(|s| !s.is_empty())
                    .map(|s| s.to_string());
                let sealed_ms = entry.get("sealed_ms").and_then(|v| v.as_u64());
                let ts = entry.get("ts").and_then(|v| v.as_u64());
                map.insert(
                    name.clone(),
                    IndexEntry {
                        unit_key: unit.to_string(),
                        source,
                        session_id,
                        sealed_ms,
                        ts,
                    },
                );
            }
        }
    }
    map
}

/// Is the installed plugin sealing at all? True once ANY index entry carries `sealed_ms`.
///
/// VERSION SKEW IS THE FAILURE THIS PREVENTS, and it is not hypothetical: the app ships as a
/// cask and the plugin ships through `claude plugin update`, so a user WILL run a new overlay
/// against an old plugin. That plugin never stamps a seal, so without this probe every indexed
/// artifact would be withheld for the full backstop — a 15-minute blackout that reads as "the
/// Board is broken", which is far worse than the churn the seal removes.
///
/// So the reader treats sealing as a capability it must OBSERVE rather than assume. One seal
/// anywhere in the index proves the writing side speaks the protocol; until then nothing is
/// withheld. Self-healing and one-directional — the first seal a new plugin writes turns the
/// feature on for good, and the cost is that the very first artifact under a brand-new index
/// surfaces early, once.
fn index_seals(index: &std::collections::HashMap<String, IndexEntry>) -> bool {
    index.values().any(|e| e.sealed_ms.is_some())
}

/// May the Board show this artifact yet?
///
/// THE RULE: an artifact is a sealed deliverable, not a live buffer. An agent authoring
/// one writes it repeatedly — a Write, some edits, a rewrite — and every one of those
/// re-stamps the index this listing polls. Showing revision 1 meant the user watched a
/// document assemble itself and got an "Updated" nag for each keystroke after it; the
/// in-flight surface is the live pane, so the artifact waits for its seal.
///
/// `entry: None` MEANS SHOW IT, and that is deliberate rather than an oversight. An
/// artifact with no index entry was never claimed by the seal protocol at all — the
/// living `home.<unit>.html` digests (which the hook pointedly never indexes so they can
/// update in place forever), hub-pulled `remote/` artifacts, and anything written where
/// the PostToolUse hook never ran. Withholding those would hide whole classes of artifact
/// permanently to fix a churn problem they never had. Un-indexed keeps its existing
/// behaviour, including surfacing fail-loud as unrouted.
///
/// Withholding therefore requires a POSITIVE "indexed, unsealed, and recent". Every
/// uncertainty — no entry, no `ts` to age against, a clock that jumped backwards — resolves
/// to visible, because a withheld artifact is invisible and an artifact the user cannot see
/// is worse than one they see too early.
fn is_settled(entry: Option<&IndexEntry>, now: u64, seal_aware: bool) -> bool {
    if !seal_aware {
        return true; // the writing side isn't sealing — withholding would strand everything
    }
    let Some(entry) = entry else { return true };
    if entry.sealed_ms.is_some() {
        return true;
    }
    // Unsealed. Hold it only while the write is recent enough to still be in flight.
    // No `ts` (a malformed or pre-seal entry) → nothing to age against → show it.
    let Some(ts) = entry.ts else { return true };
    // A future `ts` is a skewed or jumped clock, not a fresh write. Saturating here would
    // read as "age 0" and withhold it until the clock caught up — silently invisible for
    // as long as the skew lasts. Uncertainty resolves to VISIBLE, so treat it as settled.
    if ts > now {
        return true;
    }
    now - ts >= SETTLE_BACKSTOP_MS
}

/// A withheld artifact — one `is_settled` is currently holding back — reported to the Board
/// so it can show "this session is writing something" instead of nothing at all.
///
/// Deliberately NOT an `ArtifactEntry`. A pending artifact is a *signal*, not a document: it
/// has no title, no summary, and nothing to render, because the file on disk is a half-written
/// draft we have promised not to show. Giving it the same type would let it flow into the hero
/// selector, the deck and the history list — every road the seal exists to keep it off — and
/// one missed filter would put the draft back on screen. A separate, deliberately anaemic type
/// makes that mistake unavailable.
#[derive(serde::Serialize)]
pub struct PendingArtifact {
    /// Whose unit it belongs to — the Board shows the placeholder only in this unit.
    pub unit_key: String,
    /// The writing session's source stem, so the Board can scope the placeholder to the
    /// session actually on screen and never paint one for a sibling's work.
    pub source: Option<String>,
    pub session_id: Option<String>,
    /// When the draft was last written — drives "writing…" vs a staler "still writing".
    pub modified_ms: u64,
}

/// The artifacts currently being authored: indexed, unsealed, and still inside the backstop.
///
/// The exact complement of the `retain` in [`list_artifacts`], sharing [`is_settled`] so the
/// two can never disagree about what is withheld — a placeholder for an artifact the Board is
/// simultaneously showing would be worse than no placeholder at all.
///
/// Resolves the unit the same way `list_artifacts` does (registry first, stamped key as
/// fallback) so a placeholder lands in the same unit its artifact will surface in. Empty
/// whenever the plugin isn't sealing — nothing is withheld then, so nothing is pending.
#[tauri::command]
pub fn list_pending_artifacts() -> Vec<PendingArtifact> {
    let index = load_artifact_index();
    if index.is_empty() || !index_seals(&index) {
        return Vec::new();
    }
    let now = now_ms();
    let mut out: Vec<PendingArtifact> = artifact_dirs()
        .iter()
        .filter_map(|dir| std::fs::read_dir(dir).ok())
        .flatten()
        .filter_map(|e| e.ok())
        .filter_map(|e| {
            let path = e.path();
            // Reuse the listing's own file filter, so scaffolding and the living home
            // digests are excluded here exactly as they are there.
            let entry = entry_from_path(&path)?;
            let key = entry.path.clone();
            let by_name = Path::new(&key)
                .file_name()
                .and_then(|s| s.to_str())
                .and_then(|n| index.get(n));
            let idx = index.get(&key).or(by_name)?;
            if is_settled(Some(idx), now, true) {
                return None; // already shown (or released) — not pending
            }
            let unit_key = idx
                .session_id
                .as_deref()
                .and_then(crate::registry::resolve_unit)
                .unwrap_or_else(|| idx.unit_key.clone());
            Some(PendingArtifact {
                unit_key,
                source: idx.source.clone(),
                session_id: idx.session_id.clone(),
                modified_ms: entry.modified_ms,
            })
        })
        .collect();
    out.sort_by_key(|p| std::cmp::Reverse(p.modified_ms));
    out
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
    // Attach the authoritative unit key (one index read for the whole listing).
    // Prefer an exact full-path match — the hook keys on the absolute path, so two
    // artifacts that share a filename across scan dirs can't collide. Fall back to
    // a basename match for entries written by an older (basename-keyed) hook.
    let index = load_artifact_index();
    if !index.is_empty() {
        // Withhold the artifacts still being authored (see `is_settled`). Done BEFORE
        // routing so an unsealed artifact never reaches the Board at all — not by any
        // road, hero or history — rather than being surfaced and then filtered per-view.
        let now = now_ms();
        let seal_aware = index_seals(&index);
        entries.retain(|e| {
            let by_path = index.get(&e.path);
            let by_name = Path::new(&e.path)
                .file_name()
                .and_then(|s| s.to_str())
                .and_then(|n| index.get(n));
            is_settled(by_path.or(by_name), now, seal_aware)
        });
        for e in &mut entries {
            let by_path = index.get(&e.path);
            let by_name = Path::new(&e.path)
                .file_name()
                .and_then(|s| s.to_str())
                .and_then(|n| index.get(n));
            if let Some(entry) = by_path.or(by_name) {
                // PHASE 2 — registry first. If the entry carries a `session_id`, resolve
                // the unit AUTHORITATIVELY from `sessions/<id>.json`: that record was frozen
                // at SessionStart, so it's immune to the post-write-rewrite race the staleness
                // guard exists to catch — we trust it regardless of mtime and skip the guard
                // entirely. A miss (no record yet) falls through to the legacy derivation.
                let resolved = entry
                    .session_id
                    .as_deref()
                    .and_then(crate::registry::resolve_unit);
                if let Some(unit) = resolved {
                    e.unit_key = Some(unit);
                    e.source = entry.source.clone();
                    // `session_id` set ONLY on the resolved path, so its presence is a clean
                    // "routed by the registry" marker the Board can trust (and label).
                    e.session_id = entry.session_id.clone();
                    continue;
                }
                // LEGACY ENTRY (pre-registry: no session_id, or record deleted). Trust the
                // stamp as-is. The old mtime staleness guard is GONE (Phase 4): ownership
                // is decided at write time by the hook's stamp, and a later rewrite either
                // re-stamps (hook path — same or new owner, both correct) or doesn't change
                // ownership at all (a cp/Bash rewrite of the same doc). Distrusting a
                // correct entry on mtime alone is exactly what Finding B showed: the guard
                // itself CAUSED a mis-route, it never prevented one.
                e.unit_key = Some(entry.unit_key.clone());
                e.source = entry.source.clone();
            }
        }
    }
    // Remote/hub-pulled artifacts carry no index identity (the local PostToolUse
    // hook never ran for them), so they'd route to Unsourced. Give any still-unkeyed
    // entry under the `remote/` dir a stable home unit so it surfaces as a first-class
    // "Cloud" tile. Kept out of the board.ts resolver to leave routing identity alone.
    if let Some(remote) = remote_artifacts_dir() {
        for e in &mut entries {
            if e.unit_key.is_none() && Path::new(&e.path).starts_with(&remote) {
                e.unit_key = Some(match e.project.as_deref().filter(|p| is_agent_slug(p)) {
                    Some(agent) => format!("{CLOUD_UNIT_KEY}:{agent}"),
                    None => CLOUD_UNIT_KEY.to_string(),
                });
            }
        }
    }
    entries.sort_by_key(|e| std::cmp::Reverse(e.modified_ms));
    crate::trace::emit("history", "list", &[("n", &entries.len().to_string())]);
    entries
}

/// Days an artifact stays on the live listing before a sweep archives it.
const RETENTION_DAYS: u64 = 21;

/// Current time as epoch milliseconds (0 on an impossible pre-epoch clock).
fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Non-destructive retention: move artifacts older than [`RETENTION_DAYS`] into an
/// `archive/` subdir of each artifact dir, so the listing (and the Board roster)
/// stop growing without end. Reserved surfaces (`home`, `home.<unit>`) and
/// `_`-scaffolding are never touched; nothing is deleted (files stay recoverable
/// under `archive/`, and `list_artifacts` skips that subdir since it isn't `.html`
/// at the top level). Returns the count moved. Safe to call on every launch.
#[tauri::command]
pub fn sweep_artifacts() -> usize {
    let cutoff = now_ms().saturating_sub(RETENTION_DAYS * 24 * 60 * 60 * 1000);
    let mut moved = 0usize;
    for dir in artifact_dirs() {
        let archive = dir.join("archive");
        let Ok(rd) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in rd.flatten() {
            let path = entry.path();
            if !path.is_file() {
                continue;
            }
            let Some(ext) = path.extension().and_then(|e| e.to_str()) else {
                continue;
            };
            let ext = ext.to_ascii_lowercase();
            if ext != "html" && ext != "htm" {
                continue;
            }
            let Some(stem) = path.file_stem().and_then(|s| s.to_str()) else {
                continue;
            };
            // Never sweep reserved/agent surfaces or repo scaffolding.
            if stem == "home" || stem.starts_with("home.") || stem.starts_with('_') {
                continue;
            }
            let modified = std::fs::metadata(&path)
                .and_then(|m| m.modified())
                .ok()
                .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                .map(|d| d.as_millis() as u64)
                .unwrap_or(u64::MAX); // unknown mtime ⇒ keep (treat as fresh)
            if modified >= cutoff {
                continue;
            }
            let Some(name) = path.file_name() else {
                continue;
            };
            let target = archive.join(name);
            if target.exists() {
                continue; // don't clobber an earlier archived copy
            }
            if std::fs::create_dir_all(&archive).is_err() {
                continue;
            }
            if std::fs::rename(&path, &target).is_ok() {
                moved += 1;
            }
        }
    }
    moved
}

/// Resolve the agent-authored Hub dashboard (`home.html`), if one exists. The
/// Board loads it full-bleed at L0; `None` ⇒ the native fallback. It MUST live in
/// the artifacts dir (so it's in `asset:` scope and its navigate buttons' JS
/// runs), which is exactly the first of [`artifact_dirs`], so we reuse that and
/// return the first existing `home.html`.
#[tauri::command]
pub fn resolve_home() -> Option<String> {
    artifact_dirs()
        .iter()
        .map(|d| d.join("home.html"))
        .find(|p| p.is_file())
        .map(|p| p.to_string_lossy().into_owned())
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

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(sealed_ms: Option<u64>, ts: Option<u64>) -> IndexEntry {
        IndexEntry {
            unit_key: "u".into(),
            source: None,
            session_id: None,
            sealed_ms,
            ts,
        }
    }

    const NOW: u64 = 1_000_000_000;

    // THE FIX. An artifact stamped seconds ago and not yet sealed is mid-authoring:
    // the agent still holds the terminal, so the Board must not paint revision 1 and
    // then nag "Updated" for every write after it.
    #[test]
    fn withholds_an_unsealed_recent_artifact() {
        let e = entry(None, Some(NOW - 5_000));
        assert!(!is_settled(Some(&e), NOW, true));
    }

    // The Stop hook sealed it — the agent has handed the terminal back.
    #[test]
    fn shows_a_sealed_artifact() {
        let e = entry(Some(NOW - 1_000), Some(NOW - 5_000));
        assert!(is_settled(Some(&e), NOW, true));
    }

    // The backstop: a session that died before it could seal must not strand its
    // artifact invisible forever.
    #[test]
    fn shows_an_unsealed_artifact_past_the_backstop() {
        let e = entry(None, Some(NOW - SETTLE_BACKSTOP_MS - 1));
        assert!(is_settled(Some(&e), NOW, true));
    }

    // Un-indexed is NOT unsealed. The living home.<unit>.html digests are never
    // indexed by design, and remote/ artifacts never ran the local hook — withholding
    // them would hide them permanently rather than briefly.
    #[test]
    fn shows_an_unindexed_artifact() {
        assert!(is_settled(None, NOW, true));
    }

    // Entries written by a pre-seal plugin carry neither field. They must keep their
    // old behaviour (visible), not vanish on upgrade.
    #[test]
    fn shows_a_legacy_entry_with_no_timestamps() {
        let e = entry(None, None);
        assert!(is_settled(Some(&e), NOW, true));
    }

    // A backwards clock must not withhold forever — saturating_sub keeps it visible.
    #[test]
    fn shows_an_artifact_stamped_in_the_future() {
        let e = entry(None, Some(NOW + 60_000));
        assert!(is_settled(Some(&e), NOW, true));
    }

    // VERSION SKEW. A new overlay against an old plugin: nothing ever stamps a seal, so
    // withholding would black out the Board for the whole backstop window. The probe must
    // keep everything visible until it observes the writing side sealing at all.
    #[test]
    fn shows_everything_when_the_plugin_does_not_seal() {
        let e = entry(None, Some(NOW - 5_000));
        assert!(is_settled(Some(&e), NOW, false));
    }

    #[test]
    fn detects_seal_support_from_a_single_sealed_entry() {
        let mut idx = std::collections::HashMap::new();
        idx.insert("/a".to_string(), entry(None, Some(NOW)));
        assert!(!index_seals(&idx), "no sealed entry → the plugin is not sealing");
        idx.insert("/b".to_string(), entry(Some(NOW), Some(NOW)));
        assert!(index_seals(&idx), "one sealed entry proves the protocol is live");
    }
}
