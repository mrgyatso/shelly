//! Minimal per-tab PTY engine.
//!
//! The Workspace embeds a live `claude` per tab. The only ToS-compliant way to
//! run the user's own Claude subscription is to spawn the real `claude` CLI in a
//! pseudo-terminal (the Agent SDK with user OAuth was banned Feb 2026), so each
//! tab owns one PTY running `claude`.
//!
//! Ported from [TUICommander](https://github.com/mrgyatso/tuicommander)'s
//! `pty.rs` — the proven `portable-pty` + reader-thread path — trimmed to the
//! essentials: no agent-output parsing, one PTY per tab, keyed by the tab id.
//!
//! The per-tab id is injected as `COMPANION_SESSION` into the spawned `claude`'s
//! environment; the PostToolUse hook (a child of `claude`) inherits it and
//! reports it back, so artifacts route to the tab that produced them.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::Mutex;

use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use tauri::{AppHandle, Emitter, State};

/// One live PTY: the writer end, the master (for resizing), and the child handle
/// (for killing on close). The reader half lives in its own thread.
struct PtySession {
    writer: Box<dyn Write + Send>,
    master: Box<dyn MasterPty + Send>,
    child: Box<dyn Child + Send + Sync>,
}

/// Managed map of `tabId` → live PTY session.
#[derive(Default)]
pub struct PtyState(Mutex<HashMap<String, PtySession>>);

/// Drain every *complete* UTF-8 character from `buf`, returning it as a string
/// and leaving any incomplete trailing byte sequence in `buf` for the next read.
/// PTY reads split multi-byte characters across buffer boundaries; emitting only
/// the valid prefix keeps xterm.js from rendering replacement glyphs at seams.
/// Genuinely invalid bytes are replaced with U+FFFD so the loop never stalls.
fn drain_utf8(buf: &mut Vec<u8>) -> String {
    let mut out = String::new();
    loop {
        match std::str::from_utf8(buf) {
            Ok(s) => {
                out.push_str(s);
                buf.clear();
                return out;
            }
            Err(e) => {
                let valid = e.valid_up_to();
                if valid > 0 {
                    // SAFETY: `valid_up_to()` guarantees `buf[..valid]` is valid UTF-8.
                    out.push_str(unsafe { std::str::from_utf8_unchecked(&buf[..valid]) });
                }
                match e.error_len() {
                    // Genuinely invalid byte(s): emit a replacement char and skip them.
                    Some(bad) => {
                        out.push('\u{FFFD}');
                        buf.drain(..valid + bad);
                    }
                    // Incomplete trailing sequence: keep it for the next read.
                    None => {
                        buf.drain(..valid);
                        return out;
                    }
                }
            }
        }
    }
}

/// Locate the user's `claude` binary. Mirrors TUICommander's detection: ask the
/// login shell (so nvm / asdf / homebrew PATHs resolve even when the daemon was
/// launched by launchd with a minimal PATH), then fall back to known install
/// locations — including `~/.local/bin` (modern installer) and
/// `~/.claude/local` (migrate-installer).
fn find_claude() -> Option<String> {
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
    if let Ok(out) = std::process::Command::new(&shell)
        .args(["-l", "-c", "command -v claude"])
        .output()
    {
        if out.status.success() {
            let path = String::from_utf8_lossy(&out.stdout).trim().to_string();
            if !path.is_empty() && std::path::Path::new(&path).exists() {
                return Some(path);
            }
        }
    }

    let home = std::env::var("HOME").unwrap_or_default();
    [
        format!("{home}/.local/bin/claude"),
        format!("{home}/.claude/local/claude"),
        "/opt/homebrew/bin/claude".to_string(),
        "/usr/local/bin/claude".to_string(),
        format!("{home}/.npm-global/bin/claude"),
    ]
    .into_iter()
    .find(|p| std::path::Path::new(p).exists())
}

/// Inject the env `claude` / Ink need to detect terminal capabilities, plus the
/// per-tab `COMPANION_SESSION` id. Other vars are inherited from the daemon.
fn inject_env(cmd: &mut CommandBuilder, tab_id: &str) {
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    // CC ≥2.1.52 only enables the kitty keyboard protocol for WezTerm, ghostty,
    // and iTerm.app; ghostty has no app-specific side effects.
    cmd.env("TERM_PROGRAM", "ghostty");
    cmd.env("TERM_PROGRAM_VERSION", "3.0.0");
    // Don't let a nested-session marker leak in if the daemon was itself started
    // from within a Claude Code session.
    cmd.env_remove("CLAUDECODE");
    let lang = std::env::var("LANG").unwrap_or_else(|_| "en_US.UTF-8".into());
    cmd.env("LANG", lang);
    cmd.env("COMPANION_SESSION", tab_id);
}

/// Spawn the reader thread: read bytes off the PTY master, decode to UTF-8, and
/// emit `pty-output-<tabId>` events the Workspace pipes into xterm.js. On EOF
/// (the child exited or the master was dropped) emit `pty-exit-<tabId>` and end.
fn spawn_reader_thread(mut reader: Box<dyn Read + Send>, tab_id: String, app: AppHandle) {
    std::thread::spawn(move || {
        let mut raw = [0u8; 65536];
        let mut carry: Vec<u8> = Vec::new();
        loop {
            match reader.read(&mut raw) {
                Ok(0) => break,
                Ok(n) => {
                    carry.extend_from_slice(&raw[..n]);
                    let data = drain_utf8(&mut carry);
                    if !data.is_empty() {
                        let _ = app.emit(&format!("pty-output-{tab_id}"), data);
                    }
                }
                Err(_) => break,
            }
        }
        let _ = app.emit(&format!("pty-exit-{tab_id}"), &tab_id);
    });
}

fn shell_quote(path: &str) -> String {
    format!("'{}'", path.replace('\'', "'\\''"))
}

/// The `-c` script the spawn shell runs: launch `claude`, then — when it exits
/// (e.g. the user Ctrl-C's out of it) — `exec` a fresh interactive login shell so
/// the terminal stays usable instead of dying. The spawn shell itself runs
/// interactively (`-i`, see `spawn_pty`) so job control places `claude` in its own
/// foreground process group; Ctrl-C from the tty then reaches `claude` alone and
/// never tears down the surrounding shell. The `;` (not `&&`) drops to the shell
/// regardless of how `claude` exited.
fn claude_then_shell_script(claude: &str, shell: &str, resume: Option<&str>) -> String {
    let launch = match resume {
        // Rejoin a specific prior session by its full id (used when reopening a
        // session that was closed off the Board roster).
        Some(id) => format!("{} --resume {}", shell_quote(claude), shell_quote(id)),
        None => shell_quote(claude),
    };
    // Between claude exiting and the drop-to-shell, proactively disable mouse
    // tracking + bracketed paste and restore the cursor/screen buffer. A `claude`
    // that dies WITHOUT running its own cleanup (e.g. SIGABRT) otherwise leaves the
    // tty in mouse-report mode; at the bare prompt every mouse MOVE then prints its
    // coordinates as text — the "terminal typing random characters" failure. Each
    // is a no-op when the mode is already off, so a clean claude exit is unaffected,
    // and the interactive shell we exec re-enables bracketed paste itself. `\033`
    // (octal ESC) keeps this portable across any POSIX `printf`.
    let tty_reset =
        "printf '\\033[?1000l\\033[?1002l\\033[?1003l\\033[?1006l\\033[?1015l\\033[?1049l\\033[?2004l\\033[?25h\\033[0m'";
    format!(
        "{}; {}; exec {} -i -l",
        launch,
        tty_reset,
        shell_quote(shell)
    )
}

/// Spawn a `claude` PTY for `tab_id`. The PTY runs an interactive login shell
/// (`$SHELL -i -l -c '<claude>; exec $SHELL -i -l'`): the agent — and the
/// PostToolUse hook it launches — inherit a full login PATH; `-i` enables job
/// control so Ctrl-C reaches `claude` alone; and when `claude` exits the terminal
/// drops into a live shell instead of dying. See `claude_then_shell_script`.
#[tauri::command]
pub async fn spawn_pty(
    app: AppHandle,
    state: State<'_, PtyState>,
    tab_id: String,
    rows: u16,
    cols: u16,
    cwd: Option<String>,
    resume: Option<String>,
) -> Result<(), String> {
    let claude = find_claude().ok_or_else(|| {
        "Claude CLI not found. Install it with: npm install -g @anthropic-ai/claude-code"
            .to_string()
    })?;

    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows: rows.max(24),
            cols: cols.max(80),
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("openpty: {e}"))?;

    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
    let mut cmd = CommandBuilder::new(&shell);
    cmd.arg("-i");
    cmd.arg("-l");
    cmd.arg("-c");
    cmd.arg(claude_then_shell_script(&claude, &shell, resume.as_deref()));
    inject_env(&mut cmd, &tab_id);
    // A resume MUST run in the session's launch dir — the only place `claude --resume`
    // can find the transcript. The caller's cwd is the unit's `unit_dir`, which is the
    // GITROOT (for unit grouping) and so differs from the launch cwd for any session
    // started in a repo subdir (or after a mid-run `cd`). For a resume we therefore
    // resolve the authoritative dir from the transcript head and prefer it; otherwise
    // (and on lookup miss) we fall back to the supplied cwd, then HOME.
    let effective_cwd = resume
        .as_deref()
        .and_then(crate::sessions::cwd_for_session)
        .or(cwd);
    if let Some(dir) = effective_cwd {
        cmd.cwd(dir);
    } else if let Some(home) = std::env::var_os("HOME") {
        cmd.cwd(home);
    }

    let child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| format!("spawn claude: {e}"))?;
    // Drop the slave so the master sees EOF once the child exits.
    drop(pair.slave);

    let reader = pair
        .master
        .try_clone_reader()
        .map_err(|e| format!("clone reader: {e}"))?;
    let writer = pair
        .master
        .take_writer()
        .map_err(|e| format!("take writer: {e}"))?;

    spawn_reader_thread(reader, tab_id.clone(), app.clone());

    lock(&state)?.insert(
        tab_id,
        PtySession {
            writer,
            master: pair.master,
            child,
        },
    );
    Ok(())
}

/// Write raw bytes (keystrokes, or a bracketed-paste turn) into a tab's PTY.
#[tauri::command]
pub async fn write_pty(
    state: State<'_, PtyState>,
    tab_id: String,
    data: String,
) -> Result<(), String> {
    let mut map = lock(&state)?;
    let session = map
        .get_mut(&tab_id)
        .ok_or_else(|| format!("no PTY for tab {tab_id}"))?;
    session
        .writer
        .write_all(data.as_bytes())
        .map_err(|e| format!("write: {e}"))?;
    session.writer.flush().map_err(|e| format!("flush: {e}"))
}

/// Resize a tab's PTY (SIGWINCH) so `claude`'s TUI reflows to the new geometry.
#[tauri::command]
pub async fn resize_pty(
    state: State<'_, PtyState>,
    tab_id: String,
    rows: u16,
    cols: u16,
) -> Result<(), String> {
    let map = lock(&state)?;
    let session = map
        .get(&tab_id)
        .ok_or_else(|| format!("no PTY for tab {tab_id}"))?;
    session
        .master
        .resize(PtySize {
            rows: rows.max(1),
            cols: cols.max(1),
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("resize: {e}"))
}

/// Kill and forget a tab's PTY. Dropping the master makes the reader thread see
/// EOF and emit `pty-exit-<tabId>`, which ends it.
///
/// The tracked child is the login **shell** wrapper (`$SHELL -i -l -c 'claude;
/// exec $SHELL'`); `claude` runs as that shell's child in its OWN foreground
/// process group (job control via `-i`). So SIGKILLing the shell alone would
/// ORPHAN `claude` — it would keep running (the "balloon"). To actually end the
/// session we SIGHUP the shell's children first (claude sees "terminal hung up"
/// and exits, reaping its own MCP/hook children), THEN kill the shell wrapper.
/// Dropping the master at scope end is a second SIGHUP backstop.
#[tauri::command]
pub async fn close_pty(state: State<'_, PtyState>, tab_id: String) -> Result<(), String> {
    if let Some(mut session) = lock(&state)?.remove(&tab_id) {
        if let Some(pid) = session.child.process_id() {
            // Hang up claude BEFORE killing the shell, so it isn't reparented to
            // launchd (ppid→1) and lost to us first. Best-effort, dependency-free.
            let _ = std::process::Command::new("pkill")
                .args(["-HUP", "-P", &pid.to_string()])
                .status();
        }
        let _ = session.child.kill();
    }
    Ok(())
}

fn lock<'a>(
    state: &'a State<'a, PtyState>,
) -> Result<std::sync::MutexGuard<'a, HashMap<String, PtySession>>, String> {
    state.0.lock().map_err(|_| "PTY state poisoned".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn launch_script_runs_claude_then_drops_to_shell() {
        let s = claude_then_shell_script("/usr/bin/claude", "/bin/zsh", None);
        // claude runs first (quoted), so a path with spaces can't word-split.
        assert!(s.starts_with("'/usr/bin/claude';"), "got: {s}");
        // then exec a fresh interactive login shell — no wrapper left lingering.
        assert!(s.contains("exec '/bin/zsh' -i -l"), "got: {s}");
        // `;` not `&&` — drop to the shell however claude exited.
        assert!(!s.contains("&&"), "got: {s}");
        // and it disables mouse-report mode before the drop-to-shell, so a crashed
        // claude can't leave the tty printing mouse coordinates as text.
        assert!(s.contains("[?1003l") && s.contains("[?1006l"), "got: {s}");
    }

    #[test]
    fn launch_script_resumes_a_session_when_given_an_id() {
        let s = claude_then_shell_script("/usr/bin/claude", "/bin/zsh", Some("sess-42"));
        // resume the exact prior session, id quoted so it can't word-split.
        assert!(
            s.starts_with("'/usr/bin/claude' --resume 'sess-42';"),
            "got: {s}"
        );
        assert!(s.contains("exec '/bin/zsh' -i -l"), "got: {s}");
    }

    #[test]
    fn drain_utf8_keeps_incomplete_trailing_sequence() {
        // "é" is 0xC3 0xA9; feed only the first byte — it must be held back.
        let mut buf = vec![b'h', b'i', 0xC3];
        let out = drain_utf8(&mut buf);
        assert_eq!(out, "hi");
        assert_eq!(buf, vec![0xC3]);
        // Feed the continuation byte; now the char completes.
        buf.push(0xA9);
        let out2 = drain_utf8(&mut buf);
        assert_eq!(out2, "é");
        assert!(buf.is_empty());
    }

    #[test]
    fn drain_utf8_replaces_invalid_bytes() {
        let mut buf = vec![b'a', 0xFF, b'b'];
        let out = drain_utf8(&mut buf);
        assert_eq!(out, "a\u{FFFD}b");
        assert!(buf.is_empty());
    }

    /// Core spawn/read/clean path, independent of Tauri: open a PTY, run a
    /// trivial command, read its output to EOF, confirm the child exits.
    #[test]
    fn spawns_reads_and_cleans_a_pty() {
        let pty_system = native_pty_system();
        let pair = pty_system
            .openpty(PtySize {
                rows: 24,
                cols: 80,
                pixel_width: 0,
                pixel_height: 0,
            })
            .expect("openpty");

        let mut cmd = CommandBuilder::new("/bin/sh");
        cmd.arg("-c");
        cmd.arg("printf 'companion-pty-ok'");
        let mut child = pair.slave.spawn_command(cmd).expect("spawn");
        drop(pair.slave);

        let mut reader = pair.master.try_clone_reader().expect("reader");
        let mut raw = [0u8; 4096];
        let mut carry = Vec::new();
        let mut seen = String::new();
        // Read until EOF (master sees it once the child exits + slave dropped).
        loop {
            match reader.read(&mut raw) {
                Ok(0) => break,
                Ok(n) => {
                    carry.extend_from_slice(&raw[..n]);
                    seen.push_str(&drain_utf8(&mut carry));
                }
                Err(_) => break,
            }
        }
        assert!(seen.contains("companion-pty-ok"), "got: {seen:?}");

        let status = child.wait().expect("wait");
        assert!(status.success());
    }
}
