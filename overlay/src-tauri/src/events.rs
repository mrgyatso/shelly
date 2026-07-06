//! The append-only event log — read side / tailer (Rust).
//!
//! `~/.claude/companion/events.ndjson` is the source-of-truth log of what happened when
//! (`session.registered`, `artifact.routed`, …), one JSON object per line, appended by
//! `companion-identity.cjs`. Phase 3 has the Board TAIL it incrementally — reading only the
//! bytes appended since its last read — instead of re-deriving all state every poll.
//!
//! [`poll_events`] is the bridge: the Board passes the byte offset it last consumed and gets
//! back the events appended since, plus the new offset to pass next time. A partial trailing
//! line (a writer mid-append) is never consumed — the offset stops at the last complete `\n`,
//! so that line is re-read whole on the next poll. If the file is shorter than the offset
//! (rotated/truncated), the tailer resets to 0 and re-reads from the top (cold-start / self-
//! heal). The existing `list_artifacts` poll remains the fallback, so a missed event self-heals.

use std::io::{Read, Seek, SeekFrom};
use std::path::PathBuf;

use serde_json::Value;

fn events_path() -> Option<PathBuf> {
    std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".claude/companion/events.ndjson"))
}

/// A batch of newly-appended events plus the offset to resume from next time.
#[derive(serde::Serialize)]
pub struct EventBatch {
    /// Parsed events appended since `from` (unparseable lines are skipped, not fatal).
    pub events: Vec<Value>,
    /// Byte offset of the end of the last COMPLETE line consumed — pass it as `from` next
    /// poll. Never advances past a partial trailing line.
    pub next: u64,
}

/// Read the bytes of `events.ndjson` since byte offset `from`, returning the complete
/// events appended since and the new offset. `from == 0` reads the whole file (cold start).
#[tauri::command]
pub fn poll_events(from: u64) -> EventBatch {
    let empty = EventBatch {
        events: Vec::new(),
        next: from,
    };
    let Some(path) = events_path() else {
        return empty;
    };
    let Ok(mut f) = std::fs::File::open(&path) else {
        // No log yet — nothing to tail, offset unchanged.
        return empty;
    };
    let len = f.metadata().map(|m| m.len()).unwrap_or(0);
    // Rotation / truncation: the file shrank below our cursor → re-read from the top so a
    // rotated log self-heals instead of stranding the Board past EOF.
    let start = if from > len { 0 } else { from };
    if f.seek(SeekFrom::Start(start)).is_err() {
        return empty;
    }
    let mut buf = Vec::new();
    if f.read_to_end(&mut buf).is_err() {
        return empty;
    }
    // Only consume through the last newline; bytes after it are a partial line still being
    // written — leave them for the next poll to read whole.
    let last_nl = buf.iter().rposition(|&b| b == b'\n');
    let Some(end) = last_nl else {
        // No complete line yet.
        return EventBatch {
            events: Vec::new(),
            next: start,
        };
    };
    let complete = &buf[..=end];
    let next = start + complete.len() as u64;
    let events: Vec<Value> = complete
        .split(|&b| b == b'\n')
        .filter(|l| !l.is_empty())
        .filter_map(|l| serde_json::from_slice::<Value>(l).ok())
        .collect();
    crate::trace::emit(
        "events",
        "tail",
        &[
            ("count", &events.len().to_string()),
            ("from", &start.to_string()),
            ("next", &next.to_string()),
        ],
    );
    EventBatch { events, next }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    static HOME_LOCK: Mutex<()> = Mutex::new(());

    fn with_home<T>(home: &std::path::Path, f: impl FnOnce() -> T) -> T {
        let _g = HOME_LOCK.lock().unwrap();
        let prev = std::env::var_os("HOME");
        std::env::set_var("HOME", home);
        let out = f();
        match prev {
            Some(p) => std::env::set_var("HOME", p),
            None => std::env::remove_var("HOME"),
        }
        out
    }

    fn setup() -> PathBuf {
        let tmp = std::env::temp_dir().join(format!(
            "cmp-evt-{}-{:?}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        std::fs::create_dir_all(tmp.join(".claude/companion")).unwrap();
        tmp
    }
    fn log_path(home: &std::path::Path) -> PathBuf {
        home.join(".claude/companion/events.ndjson")
    }
    fn append(home: &std::path::Path, line: &str) {
        use std::io::Write;
        let mut f = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(log_path(home))
            .unwrap();
        f.write_all(line.as_bytes()).unwrap();
        f.write_all(b"\n").unwrap();
    }

    #[test]
    fn cold_start_reads_all_then_only_new() {
        let home = setup();
        append(&home, r#"{"evt":"session.registered","unit_key":"a"}"#);
        append(
            &home,
            r#"{"evt":"artifact.routed","unit_key":"a","path":"/x.html"}"#,
        );
        let b1 = with_home(&home, || poll_events(0));
        assert_eq!(b1.events.len(), 2, "cold start reads all events");
        assert_eq!(b1.events[1]["evt"], "artifact.routed");
        // No new appends → empty batch, offset unchanged.
        let b2 = with_home(&home, || poll_events(b1.next));
        assert_eq!(b2.events.len(), 0);
        assert_eq!(b2.next, b1.next);
        // One more append → only the new one comes back.
        append(
            &home,
            r#"{"evt":"artifact.routed","unit_key":"b","path":"/y.html"}"#,
        );
        let b3 = with_home(&home, || poll_events(b2.next));
        assert_eq!(b3.events.len(), 1);
        assert_eq!(b3.events[0]["unit_key"], "b");
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn partial_trailing_line_is_not_consumed() {
        use std::io::Write;
        let home = setup();
        append(&home, r#"{"evt":"a"}"#);
        // Write a partial line WITHOUT a trailing newline (a writer mid-append).
        let mut f = std::fs::OpenOptions::new()
            .append(true)
            .open(log_path(&home))
            .unwrap();
        f.write_all(br#"{"evt":"partial""#).unwrap();
        drop(f);
        let b1 = with_home(&home, || poll_events(0));
        assert_eq!(b1.events.len(), 1, "only the complete line is returned");
        assert_eq!(b1.events[0]["evt"], "a");
        // Now complete the partial line; the next poll picks it up whole.
        append(&home, r#","ok":true}"#); // closes it: {"evt":"partial","ok":true}
        let b2 = with_home(&home, || poll_events(b1.next));
        assert_eq!(b2.events.len(), 1);
        assert_eq!(b2.events[0]["evt"], "partial");
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn truncation_resets_to_top() {
        let home = setup();
        append(&home, r#"{"evt":"a"}"#);
        append(&home, r#"{"evt":"b"}"#);
        let b1 = with_home(&home, || poll_events(0));
        let far = b1.next + 9_999; // pretend we'd consumed far past the (now shorter) file
        let b2 = with_home(&home, || poll_events(far));
        assert_eq!(b2.events.len(), 2, "offset past EOF re-reads from the top");
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn missing_log_is_empty_not_fatal() {
        let home = setup();
        let b = with_home(&home, || poll_events(0));
        assert_eq!(b.events.len(), 0);
        assert_eq!(b.next, 0);
        let _ = std::fs::remove_dir_all(&home);
    }
}
