//! Recent resumable `claude` sessions, read from Claude Code's OWN transcripts.
//!
//! Claude Code persists every session to `~/.claude/projects/<encoded-cwd>/<uuid>.jsonl`
//! on every turn, independent of the Board. That makes it the DURABLE source for "recent
//! sessions" — exactly what `claude --resume` itself reads, and never pruned by the
//! Board's sidecars. The Board lists these so:
//!   1. a session orphaned by a crash / dev-rebuild / quit is one click from rejoining
//!      (`claude --resume <id>` in its original cwd), and
//!   2. the roster can derive a session's "last active" from the transcript mtime —
//!      a FREE, automatic heartbeat — instead of the agent rewriting live.json each turn.
//!
//! The encoded project-dir name is lossy (`/`, `.` → `-`), so we never decode it; we read
//! the real `cwd` out of the transcript head instead.

use std::io::BufRead;
use std::path::{Path, PathBuf};

/// One resumable session as the Board needs it.
#[derive(serde::Serialize)]
pub struct RecentSession {
    /// The transcript stem == the full session UUID; drives `claude --resume <id>`.
    pub session_id: String,
    /// The session's working dir, read from the transcript (accurate — not the lossy
    /// encoded dir name). Where a resume must be spawned.
    pub cwd: String,
    /// `basename(cwd)` — the display label / slug.
    pub project: String,
    /// Transcript file mtime (ms) — "last active". Drives recency ordering + liveness.
    pub last_active_ms: u64,
    /// Transcript size in bytes — a rough "how much work" signal (tiny ⇒ near-empty).
    pub size_bytes: u64,
    /// First real user prompt, truncated — a human title for the card (None if unreadable).
    pub title: Option<String>,
}

/// `~/.claude/projects` — Claude Code's per-project transcript root.
fn projects_dir() -> Option<PathBuf> {
    std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".claude").join("projects"))
}

/// The set of session-ids that actually have a transcript on disk (every `<uuid>.jsonl`
/// stem under any project dir). Cheap: streams directory entries by name only — no file
/// reads, no metadata. Used to gate `--resume`: a stub session (registered a session-id
/// via the SessionStart hook but never wrote a conversation) must NOT be offered for
/// resume, or `claude --resume <id>` fails with "No conversation found" and drops the
/// user on a bare shell.
pub fn existing_session_ids() -> std::collections::HashSet<String> {
    let mut ids = std::collections::HashSet::new();
    let dir = match projects_dir() {
        Some(d) => d,
        None => return ids,
    };
    let proj_entries = match std::fs::read_dir(&dir) {
        Ok(e) => e,
        Err(_) => return ids,
    };
    for pe in proj_entries.flatten() {
        let pdir = pe.path();
        if !pdir.is_dir() {
            continue;
        }
        if let Ok(files) = std::fs::read_dir(&pdir) {
            for fe in files.flatten() {
                let p = fe.path();
                if p.extension().and_then(|e| e.to_str()) == Some("jsonl") {
                    if let Some(stem) = p.file_stem().and_then(|s| s.to_str()) {
                        ids.insert(stem.to_string());
                    }
                }
            }
        }
    }
    ids
}

/// Read `cwd` + a human title from a transcript's head only (first ~60 lines, streamed —
/// never load a multi-MB transcript in full just for this). Returns `(cwd, title)`.
fn head_meta(path: &Path) -> (Option<String>, Option<String>) {
    let file = match std::fs::File::open(path) {
        Ok(f) => f,
        Err(_) => return (None, None),
    };
    let reader = std::io::BufReader::new(file);
    let mut cwd: Option<String> = None;
    let mut title: Option<String> = None;
    for line in reader.lines().take(60).map_while(Result::ok) {
        let v: serde_json::Value = match serde_json::from_str(&line) {
            Ok(v) => v,
            Err(_) => continue,
        };
        if cwd.is_none() {
            if let Some(c) = v.get("cwd").and_then(|x| x.as_str()) {
                if !c.is_empty() {
                    cwd = Some(c.to_string());
                }
            }
        }
        if title.is_none() {
            title = extract_user_title(&v);
        }
        if cwd.is_some() && title.is_some() {
            break;
        }
    }
    (cwd, title)
}

/// Pull the first genuine user prompt out of a transcript line, or None. Skips
/// tool-result continuations and machine wrappers (`<system-reminder>`, command tags,
/// `[Companion …]` feedback) so the title reads like something the human actually typed.
fn extract_user_title(v: &serde_json::Value) -> Option<String> {
    let msg = v.get("message").unwrap_or(v);
    let role = msg
        .get("role")
        .and_then(|x| x.as_str())
        .or_else(|| v.get("type").and_then(|x| x.as_str()));
    if role != Some("user") {
        return None;
    }
    let content = msg.get("content")?;
    let text = if let Some(s) = content.as_str() {
        s.to_string()
    } else if let Some(arr) = content.as_array() {
        let mut out = String::new();
        for b in arr {
            if b.get("type").and_then(|x| x.as_str()) == Some("tool_result") {
                return None; // a tool-result continuation, not a real prompt
            }
            if let Some(t) = b.get("text").and_then(|x| x.as_str()) {
                out.push_str(t);
                out.push(' ');
            }
        }
        out
    } else {
        return None;
    };
    let t = text.trim();
    if t.is_empty() || t.starts_with('<') || t.starts_with("[Companion") {
        return None;
    }
    Some(t.chars().take(90).collect())
}

/// The launch cwd for a session id, read from its transcript head — the ONLY directory
/// `claude --resume <id>` can be spawned in. Claude keys a transcript by the dir it was
/// launched in, and the Board's `unit_dir` sidecar deliberately stores the GITROOT (for
/// unit grouping), which differs from the launch cwd whenever a session starts in a repo
/// SUBDIR — or whenever the agent `cd`s mid-run. Resolving the dir from the transcript
/// head sidesteps both: it's the exact path Claude itself will look under. None when no
/// transcript exists for the id (then the caller keeps its supplied cwd).
pub fn cwd_for_session(session_id: &str) -> Option<String> {
    let dir = projects_dir()?;
    let fname = format!("{session_id}.jsonl");
    for pe in std::fs::read_dir(&dir).ok()?.flatten() {
        let pdir = pe.path();
        if !pdir.is_dir() {
            continue;
        }
        let candidate = pdir.join(&fname);
        if candidate.is_file() {
            return head_meta(&candidate).0;
        }
    }
    None
}

/// Every resumable session across all projects, newest-first, capped. The Board dedupes
/// the currently-live ones (it knows their session ids) and groups/filters by project.
/// Returns a `Vec` (never a `Result`) so one unreadable transcript can't sink the list.
#[tauri::command]
pub fn list_recent_sessions(limit: Option<usize>) -> Vec<RecentSession> {
    let dir = match projects_dir() {
        Some(d) => d,
        None => return Vec::new(),
    };
    let cap = limit.unwrap_or(40);

    // Collect (mtime, size, path) for every transcript, cheaply (metadata only).
    let mut all: Vec<(u64, u64, PathBuf)> = Vec::new();
    let proj_entries = match std::fs::read_dir(&dir) {
        Ok(e) => e,
        Err(_) => return Vec::new(),
    };
    for pe in proj_entries.flatten() {
        let pdir = pe.path();
        if !pdir.is_dir() {
            continue;
        }
        // Skip tool-internal "observer" session dirs — e.g. claude-mem spawns thousands of
        // "memory agent" sessions under ~/.claude-mem/observer-sessions; they are not
        // user-interactive work and would swamp the Recent band. (cwd backstop below.)
        if pdir
            .file_name()
            .and_then(|n| n.to_str())
            .is_some_and(|n| n.contains("claude-mem"))
        {
            continue;
        }
        let files = match std::fs::read_dir(&pdir) {
            Ok(f) => f,
            Err(_) => continue,
        };
        for fe in files.flatten() {
            let p = fe.path();
            if p.extension().and_then(|e| e.to_str()) != Some("jsonl") {
                continue;
            }
            let meta = match fe.metadata() {
                Ok(m) => m,
                Err(_) => continue,
            };
            let mtime = meta
                .modified()
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_millis() as u64)
                .unwrap_or(0);
            all.push((mtime, meta.len(), p));
        }
    }
    all.sort_by(|a, b| b.0.cmp(&a.0)); // newest first
    all.truncate(cap);

    // Read the head of only the capped set to enrich with cwd + title.
    let mut out = Vec::with_capacity(all.len());
    for (mtime, size, path) in all {
        let session_id = match path.file_stem().and_then(|s| s.to_str()) {
            Some(s) => s.to_string(),
            None => continue,
        };
        let (cwd, title) = head_meta(&path);
        let cwd = cwd.unwrap_or_default();
        // Backstop: a tool-internal session that landed outside the skipped dir.
        if cwd.contains("/.claude-mem/") {
            continue;
        }
        let project = if cwd.is_empty() {
            String::new()
        } else {
            Path::new(&cwd)
                .file_name()
                .and_then(|s| s.to_str())
                .unwrap_or("")
                .to_string()
        };
        out.push(RecentSession {
            session_id,
            cwd,
            project,
            last_active_ms: mtime,
            size_bytes: size,
            title,
        });
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn title_skips_tool_results_and_wrappers() {
        let tr = serde_json::json!({"type":"user","message":{"role":"user","content":[{"type":"tool_result","content":"x"}]}});
        assert_eq!(extract_user_title(&tr), None);
        let sysrem = serde_json::json!({"type":"user","message":{"role":"user","content":"<system-reminder>hi"}});
        assert_eq!(extract_user_title(&sysrem), None);
        let real = serde_json::json!({"type":"user","message":{"role":"user","content":"fix the roster bug"}});
        assert_eq!(
            extract_user_title(&real).as_deref(),
            Some("fix the roster bug")
        );
    }

    #[test]
    fn title_reads_text_blocks_in_array_content() {
        let arr = serde_json::json!({"type":"user","message":{"role":"user","content":[{"type":"text","text":"add recent sessions"}]}});
        assert_eq!(
            extract_user_title(&arr).as_deref(),
            Some("add recent sessions")
        );
    }

    #[test]
    fn non_user_lines_have_no_title() {
        let asst =
            serde_json::json!({"type":"assistant","message":{"role":"assistant","content":"sure"}});
        assert_eq!(extract_user_title(&asst), None);
        let meta = serde_json::json!({"type":"mode","mode":"default","sessionId":"x"});
        assert_eq!(extract_user_title(&meta), None);
    }
}
