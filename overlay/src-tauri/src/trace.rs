//! Shelly trace harness (Rust side) — the formal replacement for the ad-hoc
//! `diag.log` that lived in `artifact_watch.rs`.
//!
//! One append-only NDJSON event log shared by every layer of the artifact
//! pipeline: `~/.shelly/logs/trace.ndjson`. Each line is one event with
//! a common envelope (`ts_ms`, `layer`, `evt`, plus string fields); the artifact's
//! absolute path travels as `corr` so the whole pipeline joins on one key. The
//! shell hooks and `shelly-index.cjs` append to the SAME file through
//! `plugin/hooks/shelly-trace.cjs`, so one artifact write yields one timeline.
//!
//! GATING: off unless `SHELLY_TRACE=1` in the env OR the flag file
//! `~/.shelly/logs/trace.on` exists. The flag file is the primary switch
//! because the overlay is normally launched by a LaunchAgent that does NOT inherit
//! a shell env — a flag file is the one condition every layer (shell, node, Rust,
//! webview) can check identically. `touch` it to turn the harness on; `rm` to turn
//! it off. No relaunch needed.
//!
//! Never panics, never blocks the caller meaningfully: a failed open/write is
//! silently dropped. Each event is one `write_all` of a sub-4KB line under
//! `O_APPEND`, so lines never interleave with the Node writers'.

use std::io::Write;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::{Map, Value};

fn home() -> Option<PathBuf> {
    std::env::var_os("HOME").map(PathBuf::from)
}

fn log_dir() -> Option<PathBuf> {
    home().map(|h| h.join(".shelly/logs"))
}

/// True when the trace harness is switched on (env flag or flag file). Cheap
/// enough to call per event / per poll (one env read + at most one stat).
pub fn enabled() -> bool {
    if std::env::var("SHELLY_TRACE").ok().as_deref() == Some("1") {
        return true;
    }
    log_dir()
        .map(|d| d.join("trace.on").exists())
        .unwrap_or(false)
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn append_line(line: &str) {
    let dir = match log_dir() {
        Some(d) => d,
        None => return,
    };
    let _ = std::fs::create_dir_all(&dir);
    if let Ok(mut f) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(dir.join("trace.ndjson"))
    {
        // One write_all of "<json>\n" — atomic under O_APPEND for sub-PIPE_BUF lines.
        let mut buf = String::with_capacity(line.len() + 1);
        buf.push_str(line);
        buf.push('\n');
        let _ = f.write_all(buf.as_bytes());
    }
}

/// Append one event. `fields` are extra string-valued JSON keys; by convention a
/// `corr` field carries the artifact's absolute path. No-op unless [`enabled`].
pub fn emit(layer: &str, evt: &str, fields: &[(&str, &str)]) {
    if !enabled() {
        return;
    }
    let mut m = Map::new();
    m.insert("ts_ms".into(), Value::from(now_ms()));
    m.insert("layer".into(), Value::from(layer));
    m.insert("evt".into(), Value::from(evt));
    for (k, v) in fields {
        m.insert((*k).to_string(), Value::from(*v));
    }
    append_line(&Value::Object(m).to_string());
}

/// Webview bridge: the Board (TS) builds the full NDJSON line (with its own
/// `Date.now()` clock so the webview's wall time is what's recorded) and ships it
/// here to land on disk — the webview can't append to a file itself, and its
/// console goes nowhere readable when the Board is occluded. Fire-and-forget on
/// the TS side; gated here too so a stray call while off is a no-op.
#[tauri::command]
pub fn trace_event(line: String) {
    if !enabled() {
        return;
    }
    append_line(&line);
}

/// Let the webview gate locally: it fetches this once at startup and skips the
/// `invoke` round-trip entirely when the harness is off.
#[tauri::command]
pub fn trace_enabled() -> bool {
    enabled()
}
