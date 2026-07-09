//! Per-session token usage, read from Claude Code's OWN transcript.
//!
//! Claude Code records `message.usage` on every assistant turn it writes to
//! `~/.claude/projects/<encoded-cwd>/<uuid>.jsonl`. That makes the transcript the
//! only local source of truth for "how full is this session's context" — there is
//! no API to ask, and the CLI prints the number only when the user types
//! `/context`.
//!
//! Two different quantities come out of the same scan:
//!
//!   * CONTEXT — what the next request will carry. It is the LAST real assistant
//!     turn's four token fields, summed. Not cumulative: it is overwritten each
//!     turn, and it drops sharply after a `/compact`.
//!   * OUTPUT — tokens this session has generated. Cumulative: summed over turns.
//!
//! The context formula is verified against the number the user actually sees, not
//! inferred:
//!
//! ```text
//! context = input_tokens
//!         + cache_read_input_tokens
//!         + cache_creation_input_tokens
//!         + output_tokens      (of the LAST real assistant turn)
//! ```
//!
//! On session ef654874, `/context` printed `953.6k/1M` moments before a compaction.
//! The last assistant turn before that boundary read
//! `input=4, cache_read=948_299, cache_creation=5_346, output=204` — summing to
//! 953_853, a 0.03% match. The meter therefore agrees with `/context`, which is the
//! readout a user will compare it against.
//!
//! `compactMetadata.preTokens` looks like a tempting oracle and is NOT one. It agreed
//! at this session's first boundary (192_593) and disagreed at its second, reading
//! 1_154_905 — which exceeds the model's entire 1M window, so it cannot be "context
//! at the boundary". It tracks a different quantity (note
//! `cumulativeDroppedTokens == Σ(preTokens - postTokens)`). Don't calibrate against it.
//!
//! Read the TOP-LEVEL `message.usage` only. That object also nests an `iterations`
//! array and a `server_tool_use` block which restate the same counts — summing
//! anything nested double-counts.

use std::collections::HashMap;
use std::io::{Read, Seek, SeekFrom};
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};

/// One session's token position, as the meter needs it.
#[derive(serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SessionUsage {
    /// What the next request carries. Compare against `limit` for the % bar.
    pub context_tokens: u64,
    /// Tokens this session has generated, all turns.
    pub output_tokens: u64,
    /// The model that served the last turn, e.g. `claude-opus-4-8`.
    pub model: String,
    /// That model's context window.
    pub limit: u64,
}

/// Everything a transcript scan carries forward, so the next call only reads the
/// bytes appended since. Transcripts are append-only and reach several MB; a
/// re-parse per poll would be pure waste.
struct Scan {
    /// Bytes consumed. Always lands on a line boundary — never mid-write.
    offset: u64,
    output_tokens: u64,
    context_tokens: u64,
    model: String,
}

fn cache() -> &'static Mutex<HashMap<String, Scan>> {
    static CACHE: OnceLock<Mutex<HashMap<String, Scan>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Every current model but Haiku carries a 1M window. Prefix-matched because the
/// transcript records the bare id (`claude-opus-4-8`), and an unknown model must
/// under-promise: a meter that reads 40% when it is really 100% full is worse
/// than one that saturates early.
const MILLION: u64 = 1_000_000;
const DEFAULT_WINDOW: u64 = 200_000;
const WIDE_WINDOW_MODELS: &[&str] = &[
    "claude-opus-4-6",
    "claude-opus-4-7",
    "claude-opus-4-8",
    "claude-sonnet-4-6",
    "claude-sonnet-5",
    "claude-fable-5",
    "claude-mythos-5",
];

fn window_for(model: &str) -> u64 {
    if WIDE_WINDOW_MODELS.iter().any(|m| model.starts_with(m)) {
        MILLION
    } else {
        DEFAULT_WINDOW
    }
}

/// The transcript for a session id, wherever it lives. `None` when the session has
/// no transcript yet (a just-spawned tab) — the meter simply stays hidden.
///
/// The id comes from a file the hooks write, so it is treated as untrusted input:
/// anything but the UUID alphabet is rejected before it can reach a path join and
/// escape `~/.claude/projects` via `../`.
fn transcript_path(session_id: &str) -> Option<PathBuf> {
    if session_id.is_empty()
        || !session_id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-')
    {
        return None;
    }
    let root = PathBuf::from(std::env::var_os("HOME")?)
        .join(".claude")
        .join("projects");
    let fname = format!("{session_id}.jsonl");
    for pe in std::fs::read_dir(&root).ok()?.flatten() {
        let candidate = pe.path().join(&fname);
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    None
}

/// Fold one transcript line into a running scan. Ignores everything that is not a
/// real, main-thread assistant turn:
///
///   * `<synthetic>` — a stub Claude Code writes for an interrupt or API error. It
///     still carries a usage block, so filtering on `model` presence is not enough;
///     require a real `claude-` id.
///   * `isSidechain` — a subagent's turn. Its usage belongs to the subagent's own
///     context, not this session's, and folding it in would inflate both numbers.
fn fold_line(line: &str, scan: &mut Scan) {
    if !line.contains("\"usage\"") {
        return; // cheap reject: most lines are user turns or tool results
    }
    let v: serde_json::Value = match serde_json::from_str(line) {
        Ok(v) => v,
        Err(_) => return,
    };
    if v.get("type").and_then(|x| x.as_str()) != Some("assistant") {
        return;
    }
    if v.get("isSidechain").and_then(|x| x.as_bool()) == Some(true) {
        return;
    }
    let msg = match v.get("message") {
        Some(m) => m,
        None => return,
    };
    let model = match msg.get("model").and_then(|x| x.as_str()) {
        Some(m) if m.starts_with("claude-") => m,
        _ => return,
    };
    let usage = match msg.get("usage") {
        Some(u) => u,
        None => return,
    };
    let field = |k: &str| usage.get(k).and_then(|x| x.as_u64()).unwrap_or(0);
    let output = field("output_tokens");

    scan.output_tokens += output; // cumulative
    scan.context_tokens = field("input_tokens")     // overwritten: the LAST turn wins
        + field("cache_read_input_tokens")
        + field("cache_creation_input_tokens")
        + output;
    scan.model = model.to_string();
}

/// Read whatever has been appended since the last call and fold it in.
fn rescan(path: &PathBuf, scan: &mut Scan) {
    let mut file = match std::fs::File::open(path) {
        Ok(f) => f,
        Err(_) => return,
    };
    let len = match file.metadata() {
        Ok(m) => m.len(),
        Err(_) => return,
    };
    if len <= scan.offset {
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
    // steps past a line we never parsed and its tokens vanish for good.
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

/// This session's token position, or `None` before its transcript exists / before
/// it has taken a single assistant turn.
#[tauri::command]
pub async fn session_usage(session_id: String) -> Option<SessionUsage> {
    // Blocking file I/O: keep it off the main thread. A sync command here would
    // stall every Board interaction behind a multi-MB first read.
    tauri::async_runtime::spawn_blocking(move || {
        let path = transcript_path(&session_id)?;
        let mut cache = cache().lock().ok()?;
        let scan = cache.entry(session_id).or_insert_with(|| Scan {
            offset: 0,
            output_tokens: 0,
            context_tokens: 0,
            model: String::new(),
        });
        rescan(&path, scan);
        if scan.model.is_empty() {
            return None; // no assistant turn yet — nothing to meter
        }
        Some(SessionUsage {
            context_tokens: scan.context_tokens,
            output_tokens: scan.output_tokens,
            model: scan.model.clone(),
            limit: window_for(&scan.model),
        })
    })
    .await
    .ok()
    .flatten()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scan() -> Scan {
        Scan {
            offset: 0,
            output_tokens: 0,
            context_tokens: 0,
            model: String::new(),
        }
    }

    fn assistant(input: u64, cache_read: u64, cache_create: u64, output: u64) -> String {
        serde_json::json!({
            "type": "assistant",
            "message": {
                "model": "claude-opus-4-8",
                "usage": {
                    "input_tokens": input,
                    "cache_read_input_tokens": cache_read,
                    "cache_creation_input_tokens": cache_create,
                    "output_tokens": output,
                },
            },
        })
        .to_string()
    }

    /// Ground truth: the real turn `/context` measured on session ef654874, where it
    /// printed `953.6k/1M`. The meter must agree with that readout — it is what sits
    /// next to it on screen.
    #[test]
    fn context_matches_what_the_context_command_reports() {
        let mut s = scan();
        fold_line(&assistant(4, 948_299, 5_346, 204), &mut s);
        assert_eq!(s.context_tokens, 953_853); // `/context` said 953.6k — 0.03% off
    }

    #[test]
    fn context_is_the_last_turn_while_output_accumulates() {
        let mut s = scan();
        fold_line(&assistant(1, 100, 0, 10), &mut s);
        fold_line(&assistant(1, 200, 0, 20), &mut s);
        assert_eq!(s.context_tokens, 221, "context tracks the latest turn only");
        assert_eq!(s.output_tokens, 30, "output sums across turns");
    }

    #[test]
    fn skips_synthetic_sidechain_and_non_assistant_lines() {
        let mut s = scan();
        let synthetic = serde_json::json!({"type":"assistant","message":{"model":"<synthetic>","usage":{"output_tokens":99}}}).to_string();
        let sidechain = serde_json::json!({"type":"assistant","isSidechain":true,"message":{"model":"claude-opus-4-8","usage":{"output_tokens":99}}}).to_string();
        let user =
            serde_json::json!({"type":"user","message":{"role":"user","content":"hi"}}).to_string();
        fold_line(&synthetic, &mut s);
        fold_line(&sidechain, &mut s);
        fold_line(&user, &mut s);
        assert_eq!(s.output_tokens, 0);
        assert!(s.model.is_empty());
    }

    /// The nested `iterations` / `server_tool_use` blocks restate the same counts.
    /// Only the top-level fields may be read, or every turn double-counts.
    #[test]
    fn reads_top_level_usage_not_nested_iterations() {
        let line = serde_json::json!({
            "type": "assistant",
            "message": {"model": "claude-opus-4-8", "usage": {
                "input_tokens": 131, "cache_read_input_tokens": 112_190,
                "cache_creation_input_tokens": 1_276, "output_tokens": 351,
                "server_tool_use": {"web_search_requests": 0},
                "iterations": [{"input_tokens": 131, "output_tokens": 351,
                    "cache_read_input_tokens": 112_190, "cache_creation_input_tokens": 1_276}],
            }},
        })
        .to_string();
        let mut s = scan();
        fold_line(&line, &mut s);
        assert_eq!(s.context_tokens, 113_948);
        assert_eq!(s.output_tokens, 351);
    }

    #[test]
    fn unknown_models_get_the_conservative_window() {
        assert_eq!(window_for("claude-opus-4-8"), MILLION);
        assert_eq!(window_for("claude-sonnet-5"), MILLION);
        assert_eq!(window_for("claude-haiku-4-5"), DEFAULT_WINDOW);
        assert_eq!(window_for("claude-something-new"), DEFAULT_WINDOW);
    }

    #[test]
    fn session_ids_cannot_escape_the_projects_dir() {
        assert!(transcript_path("../../../etc/passwd").is_none());
        assert!(transcript_path("a/b").is_none());
        assert!(transcript_path("").is_none());
    }
}
