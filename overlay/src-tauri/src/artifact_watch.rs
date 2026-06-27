//! Native artifact-dir watcher — pushes `board:artifacts-changed` to the webview.
//!
//! Surfacing an artifact on the Board otherwise depends solely on the webview's
//! JS `setInterval` poll, which macOS throttles to minutes when the Board is
//! backgrounded/occluded (its state while the user works in the terminal) — so a
//! freshly written artifact would surface "late". This native polling thread is
//! NOT subject to webview throttling: it scans the artifact dirs on a steady
//! cadence and emits whenever the set changes, waking the Board's poll promptly.

use std::time::{Duration, UNIX_EPOCH};

use tauri::{AppHandle, Emitter};

/// How often the native watcher scans for changes (a dir listing + stat — cheap).
const SCAN: Duration = Duration::from_millis(700);

/// Start the artifact-dir watcher. Call once from `setup`.
pub fn init(app: &AppHandle) {
    let app = app.clone();
    std::thread::spawn(move || {
        // Seed with the current state so startup doesn't fire a spurious event.
        let mut last = scan_signature();
        loop {
            std::thread::sleep(SCAN);
            let sig = scan_signature();
            if sig != last {
                last = sig;
                let _ = app.emit("board:artifacts-changed", ());
            }
        }
    });
}

/// A cheap content signature of every `*.html` in the artifact dirs: sorted
/// `path:mtime_ms` lines. Any add, remove, or rewrite changes it.
fn scan_signature() -> String {
    let mut lines: Vec<String> = Vec::new();
    for dir in crate::history::artifact_dirs() {
        let rd = match std::fs::read_dir(&dir) {
            Ok(rd) => rd,
            Err(_) => continue,
        };
        for entry in rd.flatten() {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) != Some("html") {
                continue;
            }
            let mtime = entry
                .metadata()
                .and_then(|m| m.modified())
                .ok()
                .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                .map(|d| d.as_millis())
                .unwrap_or(0);
            lines.push(format!("{}:{}", path.display(), mtime));
        }
    }
    lines.sort();
    lines.join("\n")
}
