//! Native artifact-dir watcher — pushes `board:artifacts-changed` to the webview.
//!
//! Surfacing an artifact on the Board otherwise depends solely on the webview's
//! JS `setInterval` poll, which macOS throttles to minutes when the Board is
//! backgrounded/occluded (its state while the user works in the terminal) — so a
//! freshly written artifact would surface "late". This native polling thread is
//! NOT subject to webview throttling: it scans the artifact dirs on a steady
//! cadence and emits whenever the set changes, waking the Board's poll promptly.
//!
//! Instrumented through `crate::trace`: when the harness is on it records the tick
//! cadence (a ballooning `dt` past ~700ms = the whole process is being throttled by
//! App Nap) and one `detect` event per added/rewritten artifact (`corr` = abs path),
//! so the watcher's contribution to surfacing latency is visible end-to-end.

use std::collections::HashSet;
use std::time::{Duration, Instant, UNIX_EPOCH};

use tauri::{AppHandle, Emitter};

use crate::trace;

/// How often the native watcher scans for changes (a dir listing + stat — cheap).
const SCAN: Duration = Duration::from_millis(700);

/// Start the artifact-dir watcher. Call once from `setup`.
pub fn init(app: &AppHandle) {
    let app = app.clone();
    std::thread::spawn(move || {
        trace::emit("watcher", "start", &[("scan_ms", "700")]);
        // Seed with the current state so startup doesn't fire a spurious event.
        let mut last = scan_entries();
        let mut last_tick = Instant::now();
        let mut last_heartbeat = Instant::now();
        loop {
            std::thread::sleep(SCAN);
            let now = Instant::now();
            let dt = now.duration_since(last_tick).as_millis();
            last_tick = now;
            // Anomalous tick = the thread slept far longer than asked → throttled.
            if dt > 1100 {
                trace::emit("watcher", "slow-tick", &[("dt_ms", &dt.to_string())]);
            }
            // Heartbeat so an empty log means "healthy", not "thread dead".
            if now.duration_since(last_heartbeat) >= Duration::from_secs(30) {
                last_heartbeat = now;
                trace::emit("watcher", "heartbeat", &[("dt_ms", &dt.to_string())]);
            }
            let sig = scan_entries();
            if sig != last {
                // One `detect` per changed path so the tick ties to the specific
                // artifact(s) (corr = abs path); cheap-gate the diff work.
                if trace::enabled() {
                    let prev: HashSet<&str> = last.iter().map(|(p, _)| p.as_str()).collect();
                    let dt_s = dt.to_string();
                    for (p, m) in &sig {
                        if last.iter().any(|(lp, lm)| lp == p && lm == m) {
                            continue;
                        }
                        let kind = if prev.contains(p.as_str()) {
                            "rewrite"
                        } else {
                            "add"
                        };
                        trace::emit(
                            "watcher",
                            "detect",
                            &[("corr", p.as_str()), ("kind", kind), ("dt_ms", &dt_s)],
                        );
                    }
                }
                last = sig;
                let _ = app.emit("board:artifacts-changed", ());
                trace::emit("watcher", "emit", &[]);
            }
        }
    });
}

/// Every `*.html` in the artifact dirs as `(abs_path, mtime_ms)`, sorted by path.
/// The watcher diffs this set tick-to-tick: any add, remove, or rewrite changes it.
fn scan_entries() -> Vec<(String, u128)> {
    let mut entries: Vec<(String, u128)> = Vec::new();
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
            entries.push((path.display().to_string(), mtime));
        }
    }
    entries.sort();
    entries
}
