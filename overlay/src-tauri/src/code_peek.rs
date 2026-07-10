//! Code-peek: list the files a session has written, and read them (with their
//! pre-change text) for the read-only Monaco diff panel.
//!
//! "Peek and nudge," not an IDE. The "files in play" are the files THIS SESSION
//! has actually written — every path the agent passed to a write tool, read straight
//! out of Claude Code's own transcript, most-recent first. That is the only source
//! that answers the question the panel is really asking ("what is the agent touching
//! right now"):
//!
//!   * `git status` on the session's directory does not. A session's `unit_dir` is
//!     frozen at SessionStart, so an agent working in a git worktree, or writing
//!     anywhere outside its launch root, shows nothing. And a long-dirty file the
//!     agent never opened outranks the file it just created.
//!   * The transcript is append-only and already parsed for the usage meter, so a
//!     session's writes cost one incremental scan — no hook, no watcher, no index.
//!
//! Reads are scope-guarded to that touched set: `read_touched_file` re-derives the
//! set from the transcript and demands an exact match, so the panel can never
//! become an arbitrary file-read oracle. There is no path join to traverse out of.
//! No writes here yet; edit + save (with an mtime conflict guard) are a deliberate
//! fast-follow.

use std::collections::{HashMap, HashSet};
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Mutex, OnceLock};

use crate::usage::transcript_path;

/// The tools whose path argument means "the agent wrote here". Read is deliberately
/// absent: the panel shows work done, not files glanced at. Mind the key — every one
/// of these carries `file_path` EXCEPT `NotebookEdit`, which uses `notebook_path`.
const WRITE_TOOLS: [&str; 4] = ["Write", "Edit", "MultiEdit", "NotebookEdit"];

/// A file the session has written.
#[derive(serde::Serialize, Clone, PartialEq, Debug)]
pub struct TouchedFile {
    /// Absolute path — what the panel passes back to [`read_touched_file`], and
    /// what the scope guard matches on.
    pub path: String,
    /// Repo-root-relative when the file sits in a git repo, else the bare path.
    /// Display only.
    pub rel: String,
    /// Porcelain status for the badge: `M`, `A`, `D`, `??`, or `""` when the file
    /// is inside no repo (or the write left it identical to HEAD).
    pub status: String,
}

/// One session's accumulated transcript scan. Transcripts are append-only and
/// reach several MB, so each poll reads only the bytes appended since the last.
struct Scan {
    /// Bytes consumed. Always lands on a line boundary — never mid-write.
    offset: u64,
    /// Touched absolute paths, oldest first. A re-touch moves a path to the end,
    /// so the tail is the most recent work; the command reverses it for display.
    paths: Vec<String>,
}

fn cache() -> &'static Mutex<HashMap<String, Scan>> {
    static CACHE: OnceLock<Mutex<HashMap<String, Scan>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Companion's own bookkeeping, which the agent rewrites every single turn: the
/// live status JSON, the artifacts it renders into the Board, and its per-project
/// memory. All are surfaced elsewhere in the UI; listing them here would bury the
/// two or three source files the user actually wants to see.
fn is_companion_bookkeeping(path: &str) -> bool {
    let under = |dir: Option<PathBuf>| {
        dir.is_some_and(|d| path.starts_with(&format!("{}/", d.display())))
    };
    under(crate::paths::companion_dir()) || under(crate::paths::projects_dir())
}

/// Fold one transcript line into a running scan, recording every path the assistant
/// wrote to. Subagent turns (`isSidechain`) are deliberately KEPT — a file an agent
/// delegated to a subagent is still a file in play. (This is the opposite of the
/// usage meter, whose tokens belong to the subagent's own context, not this one's.)
fn fold_line(line: &str, scan: &mut Scan) {
    if !line.contains("\"tool_use\"") {
        return; // cheap reject: most lines carry no tool call at all
    }
    let v: serde_json::Value = match serde_json::from_str(line) {
        Ok(v) => v,
        Err(_) => return,
    };
    if v.get("type").and_then(|x| x.as_str()) != Some("assistant") {
        return;
    }
    let blocks = match v.pointer("/message/content").and_then(|c| c.as_array()) {
        Some(b) => b,
        None => return,
    };
    for b in blocks {
        if b.get("type").and_then(|x| x.as_str()) != Some("tool_use") {
            continue;
        }
        let name = b.get("name").and_then(|x| x.as_str()).unwrap_or("");
        if !WRITE_TOOLS.contains(&name) {
            continue;
        }
        // `NotebookEdit` names its target `notebook_path`; every other write tool
        // uses `file_path`. Both are absolute by the tools' own contract.
        let fp = match b
            .get("input")
            .and_then(|i| i.get("file_path").or_else(|| i.get("notebook_path")))
            .and_then(|x| x.as_str())
        {
            Some(p) if p.starts_with('/') => p,
            _ => continue, // a relative path can't be resolved after the fact
        };
        if is_companion_bookkeeping(fp) {
            continue;
        }
        // Re-touch = most recent. Drop the older mention so `paths` stays a set
        // ordered by recency rather than by first sighting.
        scan.paths.retain(|p| p != fp);
        scan.paths.push(fp.to_string());
    }
}

/// Read whatever has been appended since the last call and fold it in.
fn rescan(path: &Path, scan: &mut Scan) {
    let mut file = match std::fs::File::open(path) {
        Ok(f) => f,
        Err(_) => return,
    };
    let len = match file.metadata() {
        Ok(m) => m.len(),
        Err(_) => return,
    };
    if len < scan.offset {
        // The transcript was truncated or replaced under us — start over rather
        // than seek past its end and read nothing, forever.
        scan.offset = 0;
        scan.paths.clear();
    }
    if len == scan.offset {
        return; // nothing new
    }
    if file.seek(SeekFrom::Start(scan.offset)).is_err() {
        return;
    }
    let mut buf = Vec::with_capacity((len - scan.offset) as usize);
    if file.read_to_end(&mut buf).is_err() {
        return;
    }
    // Claude appends while we read, so the tail may be half a line. Stop at the
    // last newline and leave the remainder for next time — otherwise the offset
    // steps past a line we never parsed and its writes vanish for good.
    let end = match buf.iter().rposition(|&b| b == b'\n') {
        Some(i) => i + 1,
        None => return,
    };
    let text = String::from_utf8_lossy(&buf[..end]);
    for line in text.lines() {
        fold_line(line, scan);
    }
    scan.offset += end as u64;
}

/// Every absolute path `session_id` has written, most recent first.
fn touched_paths(session_id: &str) -> Vec<String> {
    let path = match transcript_path(session_id) {
        Some(p) => p,
        None => return Vec::new(),
    };
    let mut cache = match cache().lock() {
        Ok(c) => c,
        Err(_) => return Vec::new(),
    };
    let scan = cache.entry(session_id.to_string()).or_insert_with(|| Scan {
        offset: 0,
        paths: Vec::new(),
    });
    rescan(&path, scan);
    scan.paths.iter().rev().cloned().collect()
}

/// The repository top-level containing `dir`, or `None` when it isn't in a repo.
fn repo_toplevel(dir: &Path) -> Option<PathBuf> {
    let out = Command::new("git")
        .arg("-C")
        .arg(dir)
        .args(["rev-parse", "--show-toplevel"])
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
    (!s.is_empty()).then(|| PathBuf::from(s))
}

/// Parse one `git status --porcelain` line into (repo-relative path, status).
/// Handles the rename form `R  old -> new` (takes `new`).
fn parse_porcelain_line(line: &str) -> Option<(String, String)> {
    // Porcelain v1: two status chars, a space, then the path (`XY <path>`).
    if line.len() < 4 {
        return None;
    }
    let status = line[..2].trim().to_string();
    let rest = line[3..].trim();
    // A rename/copy reports `old -> new`; the file in play is the new path.
    let path = match rest.split_once(" -> ") {
        Some((_, new)) => new,
        None => rest,
    };
    if path.is_empty() || path.ends_with('/') {
        None
    } else {
        Some((path.to_string(), status))
    }
}

/// `git status` for one repo, as repo-relative path → status. One process per repo,
/// not per file. `core.quotePath=false` keeps non-ASCII paths literal (no C-style
/// `\NNN` escaping to unquote).
fn statuses_for(root: &Path) -> HashMap<String, String> {
    let out = Command::new("git")
        .args(["-c", "core.quotePath=false", "-C"])
        .arg(root)
        .args(["status", "--porcelain", "--untracked-files=all"])
        .output();
    let out = match out {
        Ok(o) if o.status.success() => o,
        _ => return HashMap::new(),
    };
    String::from_utf8_lossy(&out.stdout)
        .lines()
        .filter_map(parse_porcelain_line)
        .collect()
}

/// Resolve `path` to its real location when it exists. A deleted file can't be
/// canonicalized, so it keeps the path the transcript recorded.
fn real_path(path: &str) -> PathBuf {
    let p = PathBuf::from(path);
    p.canonicalize().unwrap_or(p)
}

/// The repo root for `path`'s directory, memoized per directory so a run of files in
/// one project costs a single `git rev-parse`.
fn root_for(path: &Path, roots: &mut HashMap<PathBuf, Option<PathBuf>>) -> Option<PathBuf> {
    let dir = path.parent().unwrap_or(path).to_path_buf();
    roots
        .entry(dir.clone())
        .or_insert_with(|| repo_toplevel(&dir))
        .clone()
}

/// Whether a touched path has anything left to render: the file on disk, or — once
/// it's gone — a HEAD blob to show as a deletion.
///
/// Deliberately NOT keyed off the porcelain status. The code is two columns, and a
/// `D` in either can mean different things: `MD` is a tracked file deleted from the
/// worktree (HEAD has it — show the deletion), while `AD` and `RD` are paths git has
/// never committed, deleted before they ever reached HEAD (nothing to show). Asking
/// for the blob answers the question directly, and it is the same question
/// [`read_touched_file`] asks — so the list and the read can never disagree about
/// which chips are clickable.
fn is_displayable(exists_on_disk: bool, has_head_blob: bool) -> bool {
    exists_on_disk || has_head_blob
}

/// The files `session_id` has written, most recent first, each tagged with the
/// working-tree status git reports for it. Empty before the session's first write
/// (or when it has no transcript yet) — the panel then shows its empty state.
#[tauri::command]
pub async fn session_files(session_id: String) -> Vec<TouchedFile> {
    // Blocking file I/O and git subprocesses: keep both off the main thread. A sync
    // command here would stall every Board interaction behind a multi-MB first read.
    tauri::async_runtime::spawn_blocking(move || {
        let mut roots: HashMap<PathBuf, Option<PathBuf>> = HashMap::new();
        let mut statuses: HashMap<PathBuf, HashMap<String, String>> = HashMap::new();
        touched_paths(&session_id)
            .into_iter()
            .filter_map(|abs| {
                let real = real_path(&abs);
                let root = root_for(&real, &mut roots);
                let (rel, status) = match &root {
                    Some(root) => {
                        let rel = real
                            .strip_prefix(root)
                            .map(|r| r.to_string_lossy().into_owned())
                            .unwrap_or_else(|_| abs.clone());
                        let status = statuses
                            .entry(root.clone())
                            .or_insert_with(|| statuses_for(root))
                            .get(&rel)
                            .cloned()
                            .unwrap_or_default();
                        (rel, status)
                    }
                    // Outside any repo (a scratch dir, say): no rel, no status.
                    None => (abs.clone(), String::new()),
                };
                // The blob lookup costs a `git show`, so only pay it for a file that
                // has left the disk — the rare case, and the only one it decides.
                let exists = real.exists();
                let has_head_blob = || match &root {
                    Some(root) => head_blob(root, &rel).is_some(),
                    None => false,
                };
                if !is_displayable(exists, !exists && has_head_blob()) {
                    return None;
                }
                Some(TouchedFile {
                    path: abs,
                    rel,
                    status,
                })
            })
            .collect()
    })
    .await
    .unwrap_or_default()
}

/// A file in play, as the diff panel renders it: the text on disk now, plus the text
/// at HEAD so Monaco can show what the session changed.
#[derive(serde::Serialize)]
pub struct FileView {
    /// The file's current contents. Empty when the session deleted it.
    pub content: String,
    /// The file's contents at git HEAD, or `None` when it is new (or untracked, or
    /// outside a repo) — Monaco then renders the whole file as an addition.
    pub original: Option<String>,
    /// The session wrote this file and it is no longer on disk.
    pub deleted: bool,
}

/// The file's text at HEAD, or `None` when git has no such blob (a new file).
fn head_blob(root: &Path, rel: &str) -> Option<String> {
    let out = Command::new("git")
        .arg("-C")
        .arg(root)
        .args(["show", &format!("HEAD:{rel}")])
        .output()
        .ok()?;
    out.status
        .success()
        .then(|| String::from_utf8_lossy(&out.stdout).into_owned())
}

/// Read a file the session wrote, with its HEAD text for the diff.
///
/// `path` is the absolute path [`session_files`] returned. The guard is exact
/// membership in the freshly-derived touched set — NOT a prefix check against some
/// root — so there is no path to traverse out of and no repo to escape. A path the
/// session never wrote is simply not readable through this command.
#[tauri::command]
pub async fn read_touched_file(session_id: String, path: String) -> Result<FileView, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let touched: HashSet<String> = touched_paths(&session_id).into_iter().collect();
        if !touched.contains(&path) {
            return Err("this session has not written that file".into());
        }
        let real = real_path(&path);
        let content = std::fs::read_to_string(&real);
        let original = repo_toplevel(real.parent().unwrap_or(&real)).and_then(|root| {
            let rel = real.strip_prefix(&root).ok()?;
            head_blob(&root, &rel.to_string_lossy())
        });
        match content {
            Ok(content) => Ok(FileView {
                content,
                original,
                deleted: false,
            }),
            // Gone from disk but present at HEAD ⇒ the session deleted it; show the
            // deletion as a diff rather than an error.
            Err(_) if original.is_some() => Ok(FileView {
                content: String::new(),
                original,
                deleted: true,
            }),
            Err(e) => Err(e.to_string()),
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    /// One transcript line carrying a single write, using the path key the tool
    /// actually emits — `NotebookEdit` has no `file_path` at all. A fixture that
    /// wrote `file_path` for every tool would assert against its own fiction.
    fn write_line(tool: &str, path: &str) -> String {
        let key = if tool == "NotebookEdit" {
            "notebook_path"
        } else {
            "file_path"
        };
        format!(
            r#"{{"type":"assistant","message":{{"content":[{{"type":"tool_use","name":"{tool}","input":{{"{key}":"{path}"}}}}]}}}}"#
        )
    }

    fn scan_of(lines: &[String]) -> Scan {
        let mut scan = Scan {
            offset: 0,
            paths: Vec::new(),
        };
        for l in lines {
            fold_line(l, &mut scan);
        }
        scan
    }

    #[test]
    fn records_every_write_tool() {
        let lines: Vec<String> = WRITE_TOOLS
            .iter()
            .enumerate()
            .map(|(i, t)| write_line(t, &format!("/repo/f{i}.rs")))
            .collect();
        assert_eq!(scan_of(&lines).paths.len(), WRITE_TOOLS.len());
    }

    /// Regression: `fold_line` once read only `/input/file_path`, silently dropping
    /// every notebook the session edited.
    #[test]
    fn a_notebook_edit_is_recorded_from_notebook_path() {
        let scan = scan_of(&[write_line("NotebookEdit", "/repo/analysis.ipynb")]);
        assert_eq!(scan.paths, vec!["/repo/analysis.ipynb"]);
    }

    #[test]
    fn ignores_reads_and_other_tools() {
        let scan = scan_of(&[
            write_line("Read", "/repo/a.rs"),
            write_line("Bash", "/repo/b.rs"),
        ]);
        assert!(scan.paths.is_empty());
    }

    #[test]
    fn a_retouch_moves_the_file_to_the_most_recent_end() {
        let scan = scan_of(&[
            write_line("Write", "/repo/a.rs"),
            write_line("Write", "/repo/b.rs"),
            write_line("Edit", "/repo/a.rs"),
        ]);
        // Oldest first internally; `session_files` reverses it for display.
        assert_eq!(scan.paths, vec!["/repo/b.rs", "/repo/a.rs"]);
    }

    #[test]
    fn skips_relative_paths() {
        assert!(scan_of(&[write_line("Write", "relative/f.rs")])
            .paths
            .is_empty());
    }

    #[test]
    fn skips_companion_bookkeeping() {
        let home = std::env::var("HOME").unwrap();
        let scan = scan_of(&[
            write_line("Write", &format!("{home}/.claude/companion/live/x--1.json")),
            write_line("Write", &format!("{home}/.claude/projects/-p/memory/m.md")),
            write_line("Write", "/repo/real.rs"),
        ]);
        assert_eq!(scan.paths, vec!["/repo/real.rs"]);
    }

    #[test]
    fn a_user_turn_echoing_a_tool_use_block_is_not_a_write() {
        let line = r#"{"type":"user","message":{"content":[{"type":"tool_use","name":"Write","input":{"file_path":"/repo/x.rs"}}]}}"#;
        assert!(scan_of(&[line.to_string()]).paths.is_empty());
    }

    /// The guard is membership, not a prefix check: a path the session never wrote is
    /// unreadable even when it sits inside the very repo the session works in.
    #[test]
    fn the_touched_set_excludes_a_sibling_file_in_the_same_repo() {
        let scan = scan_of(&[write_line("Write", "/repo/written.rs")]);
        let touched: HashSet<&String> = scan.paths.iter().collect();
        assert!(touched.contains(&"/repo/written.rs".to_string()));
        assert!(!touched.contains(&"/repo/secret.rs".to_string()));
    }

    #[test]
    fn parses_modified_untracked_and_renamed_status_lines() {
        assert_eq!(
            parse_porcelain_line(" M overlay/src/board.ts"),
            Some(("overlay/src/board.ts".into(), "M".into()))
        );
        assert_eq!(
            parse_porcelain_line("?? new.rs"),
            Some(("new.rs".into(), "??".into()))
        );
        assert_eq!(
            parse_porcelain_line("R  old.rs -> new.rs"),
            Some(("new.rs".into(), "R".into()))
        );
    }

    #[test]
    fn ignores_status_lines_without_a_readable_path() {
        assert_eq!(parse_porcelain_line(""), None);
        assert_eq!(parse_porcelain_line("M"), None);
        assert_eq!(parse_porcelain_line("?? .claude/"), None); // collapsed dir
    }

    /// A fresh temp dir per test — `SystemTime` is only µs-resolved on macOS, so two
    /// tests naming their dir by timestamp collide under `cargo test`'s thread pool.
    fn temp_dir(tag: &str) -> PathBuf {
        static N: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
        let n = N.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!("code_peek_{tag}_{}_{n}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// A transcript that SHRINKS was replaced under us. Detection is by length alone,
    /// so a same-length rewrite is invisible — as it is to the usage meter, and as it
    /// is in practice: Claude Code only ever appends, and starts a new file on resume.
    #[test]
    fn a_truncated_transcript_resets_the_scan_instead_of_stalling() {
        let dir = temp_dir("rescan");
        let path = dir.join("t.jsonl");

        let a = write_line("Write", "/repo/a.rs");
        std::fs::write(&path, format!("{a}\n{a}\n")).unwrap();
        let mut scan = Scan {
            offset: 0,
            paths: Vec::new(),
        };
        rescan(&path, &mut scan);
        assert_eq!(scan.paths, vec!["/repo/a.rs"]);

        // Replaced by a shorter transcript: the old offset now sits past its end.
        std::fs::write(&path, format!("{}\n", write_line("Write", "/repo/b.rs"))).unwrap();
        rescan(&path, &mut scan);
        assert_eq!(scan.paths, vec!["/repo/b.rs"]);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_partial_trailing_line_is_left_for_the_next_scan() {
        let dir = temp_dir("partial");
        let path = dir.join("t.jsonl");

        let full = write_line("Write", "/repo/a.rs");
        let b = write_line("Write", "/repo/b.rs");
        std::fs::write(&path, format!("{full}\n{}", &b[..20])).unwrap();
        let mut scan = Scan {
            offset: 0,
            paths: Vec::new(),
        };
        rescan(&path, &mut scan);
        assert_eq!(scan.paths, vec!["/repo/a.rs"]);

        // Claude finishes the line; the next scan picks it up whole, exactly once.
        std::fs::write(&path, format!("{full}\n{b}\n")).unwrap();
        rescan(&path, &mut scan);
        assert_eq!(scan.paths, vec!["/repo/a.rs", "/repo/b.rs"]);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn head_blob_is_none_for_a_file_git_has_never_seen() {
        let dir = temp_dir("headblob");
        assert_eq!(head_blob(&dir, "nope.rs"), None);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A file still on disk always shows. Once it's gone, only a HEAD blob can carry
    /// it — which is why the porcelain code doesn't decide this: `MD` (tracked, then
    /// deleted from the worktree) has a blob and must stay as a visible deletion,
    /// while `AD`/`RD` and a plain scratch file never reached HEAD and have nothing
    /// to render.
    #[test]
    fn a_file_shows_while_it_exists_or_while_head_still_has_it() {
        assert!(is_displayable(true, false)); // on disk, new (?? / A)
        assert!(is_displayable(true, true)); // on disk, tracked (M)
        assert!(is_displayable(false, true)); // gone, but HEAD has it (D / MD) — show the deletion
        assert!(!is_displayable(false, false)); // gone, never committed (AD / RD / scratch) — no chip
    }

    /// `repo_toplevel` spawns `git`, and spawning reads `environ` to build the child's
    /// `envp`. While tests mutated `$HOME`, writing this test would have raced that read
    /// and failed with a spurious ENOENT — so it was never written, and the function went
    /// untested. Nothing mutates the environment now (see `paths`), so it is safe.
    #[test]
    fn repo_toplevel_finds_the_root_and_rejects_a_non_repo() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        static NEXT: AtomicUsize = AtomicUsize::new(0);
        let base = std::env::temp_dir().join(format!(
            "cmp-peek-git-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        let _ = std::fs::remove_dir_all(&base);
        let nested = base.join("a/b");
        std::fs::create_dir_all(&nested).unwrap();

        // Not a repo yet — and `temp_dir()` is not inside one either.
        assert!(repo_toplevel(&base).is_none());

        assert!(Command::new("git")
            .args(["-C", base.to_str().unwrap(), "init", "--quiet"])
            .status()
            .unwrap()
            .success());

        // From a nested dir, the toplevel is still the repo root. Canonicalize both:
        // on macOS `/var` is a symlink to `/private/var`, and git reports the real path.
        let top = repo_toplevel(&nested).unwrap();
        assert_eq!(top, base.canonicalize().unwrap());

        let _ = std::fs::remove_dir_all(&base);
    }
}
