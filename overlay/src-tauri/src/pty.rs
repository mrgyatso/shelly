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
use std::sync::mpsc::{self, RecvTimeoutError};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use tauri::{AppHandle, Emitter, State};

/// How long the flusher lets PTY bytes pool before handing them to the webview.
///
/// A PTY delivers output as it arrives, so a streaming `claude` produces many
/// small reads — measured at ~640 reads/s averaging ~570 B across a Board of 7
/// live sessions. Emitting per read put that many IPC messages, and that many
/// `term.write()` calls, on the webview's *main* thread — the one thread that
/// also lays out, paints, and dispatches input — pinning it at 54–91% of a core
/// and starving keystrokes. (The machine was 95% idle throughout: this is a
/// single-thread latency problem, not a throughput one, so a faster CPU never
/// fixed it.) One batch per frame collapses that to ~60 wakeups/s per terminal.
/// The cost is at most one frame of added latency, which is imperceptible.
const FLUSH: Duration = Duration::from_millis(16);

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

/// The user's shell, falling back to the platform default when `SHELL` is unset
/// (macOS has defaulted to zsh since Catalina; Linux distros ship bash).
fn user_shell() -> String {
    let fallback = if cfg!(target_os = "macos") {
        "/bin/zsh"
    } else {
        "/bin/bash"
    };
    std::env::var("SHELL").unwrap_or_else(|_| fallback.into())
}

/// Locate an agent CLI (`claude` or `codex`). Mirrors TUICommander's detection:
/// ask the login shell (so nvm / asdf / homebrew PATHs resolve even when the
/// daemon was launched by launchd with a minimal PATH), then fall back to known
/// install locations — including `~/.local/bin` (modern installer),
/// `~/.claude/local` (claude migrate-installer), and `~/.local/node/bin`
/// (a user-prefix node that carries a global npm codex).
pub(crate) fn find_agent(bin: &str) -> Option<String> {
    let shell = user_shell();
    if let Ok(out) = std::process::Command::new(&shell)
        .args(["-l", "-c", &format!("command -v {bin}")])
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
        format!("{home}/.local/bin/{bin}"),
        format!("{home}/.claude/local/{bin}"),
        format!("{home}/.local/node/bin/{bin}"),
        format!("/opt/homebrew/bin/{bin}"),
        format!("/usr/local/bin/{bin}"),
        format!("/usr/bin/{bin}"),
        format!("{home}/.npm-global/bin/{bin}"),
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
fn spawn_reader_thread(reader: Box<dyn Read + Send>, tab_id: String, app: AppHandle) {
    let (tx, rx) = mpsc::channel::<String>();
    spawn_pty_pump(reader, tx);
    spawn_flusher(rx, tab_id, app);
}

/// PTY → channel. Reads stay off the webview entirely: this thread must never
/// block on an `emit`, or a slow frame in the webview would back-pressure the
/// terminal the user is actually typing into.
fn spawn_pty_pump(mut reader: Box<dyn Read + Send>, tx: mpsc::Sender<String>) {
    std::thread::spawn(move || {
        let mut raw = [0u8; 65536];
        let mut carry: Vec<u8> = Vec::new();
        loop {
            match reader.read(&mut raw) {
                Ok(0) => break,
                Ok(n) => {
                    carry.extend_from_slice(&raw[..n]);
                    let data = drain_utf8(&mut carry);
                    // Receiver gone (session torn down): stop pumping.
                    if !data.is_empty() && tx.send(data).is_err() {
                        return;
                    }
                }
                Err(_) => break,
            }
        }
        // Dropping `tx` disconnects the channel, which is how the flusher learns
        // the PTY hit EOF — it emits `pty-exit` only after draining the last byte.
    });
}

/// Channel → webview, at most one `pty-output` per [`FLUSH`] window.
///
/// Rate-limiting inside the read loop instead would strand the tail: `read()`
/// blocks, so a withheld chunk (a shell prompt, say) would sit unsent until the
/// *next* byte arrived — which, at a prompt, is exactly never. Pooling on a
/// deadline in its own thread bounds the delay whether or not more output comes.
fn spawn_flusher(rx: mpsc::Receiver<String>, tab_id: String, app: AppHandle) {
    std::thread::spawn(move || {
        let out_evt = format!("pty-output-{tab_id}");
        let exit_evt = format!("pty-exit-{tab_id}");
        let mut batch = String::new();

        loop {
            // Idle: block outright. An idle terminal costs zero wakeups, so a
            // Board full of parked sessions is free.
            match rx.recv() {
                Ok(first) => batch.push_str(&first),
                Err(_) => break, // EOF with nothing pending
            }

            // First byte of a batch opens the window; absorb whatever lands inside it.
            let deadline = Instant::now() + FLUSH;
            loop {
                let left = deadline.saturating_duration_since(Instant::now());
                if left.is_zero() {
                    break;
                }
                match rx.recv_timeout(left) {
                    Ok(more) => batch.push_str(&more),
                    Err(RecvTimeoutError::Timeout) => break,
                    Err(RecvTimeoutError::Disconnected) => {
                        let _ = app.emit(&out_evt, std::mem::take(&mut batch));
                        let _ = app.emit(&exit_evt, &tab_id);
                        return;
                    }
                }
            }
            let _ = app.emit(&out_evt, std::mem::take(&mut batch));
        }

        let _ = app.emit(&exit_evt, &tab_id);
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
fn claude_then_shell_script(agent_path: &str, shell: &str, resume: Option<&str>, agent: &str) -> String {
    let launch = match resume {
        // Rejoin a specific prior session by its full id (used when reopening a
        // session that was closed off the Board roster). The resume verb is the
        // one CLI-visible difference between the agents: `claude --resume <id>`
        // vs `codex resume <id>`.
        Some(id) if agent == "codex" => {
            format!("{} resume {}", shell_quote(agent_path), shell_quote(id))
        }
        Some(id) => format!("{} --resume {}", shell_quote(agent_path), shell_quote(id)),
        None => shell_quote(agent_path),
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
    agent: Option<String>,
) -> Result<(), String> {
    // Which agent CLI this tab embeds. "claude" (default) or "codex" — the
    // provider recorded in the session's registry record at SessionStart, echoed
    // back by the frontend on resume so a Codex session rejoins through codex.
    let agent = match agent.as_deref() {
        Some("codex") => "codex",
        _ => "claude",
    };
    let agent_path = find_agent(agent).ok_or_else(|| match agent {
        "codex" => "Codex CLI not found. Install it with: npm install -g @openai/codex".to_string(),
        _ => "Claude CLI not found. Install it with: npm install -g @anthropic-ai/claude-code"
            .to_string(),
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

    let shell = user_shell();
    let mut cmd = CommandBuilder::new(&shell);
    cmd.arg("-i");
    cmd.arg("-l");
    cmd.arg("-c");
    cmd.arg(claude_then_shell_script(&agent_path, &shell, resume.as_deref(), agent));
    inject_env(&mut cmd, &tab_id);
    // A resume MUST run in the session's launch dir — the only place a resume
    // can find the transcript. The caller's cwd is the unit's `unit_dir`, which is the
    // GITROOT (for unit grouping) and so differs from the launch cwd for any session
    // started in a repo subdir (or after a mid-run `cd`). For a resume we therefore
    // resolve the authoritative dir from the transcript head and prefer it; otherwise
    // (and on lookup miss) we fall back to the supplied cwd, then HOME. (Codex records
    // its own launch cwd in the rollout's session_meta line; same idea, different file.)
    let effective_cwd = resume
        .as_deref()
        .and_then(|id| {
            if agent == "codex" {
                crate::sessions::cwd_for_codex_session(id)
            } else {
                crate::sessions::cwd_for_session(id)
            }
        })
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

/// Whether the Codex CLI is installed on this machine — gates the Board's
/// "+ New codex session" menu entries (checked once per menu open, frontend-cached).
#[tauri::command]
pub fn codex_available() -> bool {
    find_agent("codex").is_some()
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
        let s = claude_then_shell_script("/usr/bin/claude", "/bin/zsh", None, "claude");
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
        let s = claude_then_shell_script("/usr/bin/claude", "/bin/zsh", Some("sess-42"), "claude");
        // resume the exact prior session, id quoted so it can't word-split.
        assert!(
            s.starts_with("'/usr/bin/claude' --resume 'sess-42';"),
            "got: {s}"
        );
        assert!(s.contains("exec '/bin/zsh' -i -l"), "got: {s}");
    }

    #[test]
    fn launch_script_resumes_codex_with_its_own_verb() {
        // Codex spells it `codex resume <id>` (a subcommand, not a flag).
        let s = claude_then_shell_script("/usr/bin/codex", "/bin/zsh", Some("0199a213-81c0"), "codex");
        assert!(
            s.starts_with("'/usr/bin/codex' resume '0199a213-81c0';"),
            "got: {s}"
        );
        assert!(s.contains("exec '/bin/zsh' -i -l"), "got: {s}");
        // and a plain codex spawn is just the binary.
        let plain = claude_then_shell_script("/usr/bin/codex", "/bin/zsh", None, "codex");
        assert!(plain.starts_with("'/usr/bin/codex';"), "got: {plain}");
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
        // This test used to need the env lock: spawning reads `environ` to build the
        // child's `envp`, and a concurrent `set_var` tore it, failing the spawn with a
        // baffling ENOENT for a `/bin/sh` that plainly exists. Nothing mutates the
        // environment any more (see `paths`), so the lock is gone and so is the class.
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
