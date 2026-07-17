//! One definition of where the Shelly's files live.
//!
//! `registry`, `live` and `hub` each carried their own copy of the same
//! `shelly_dir()` — byte-for-byte — so there was no single answer to
//! "where is the shelly home". They all delegate here now.
//!
//! **Tests override the home with a thread-local, never `std::env::set_var`.** Mutating
//! the environment is not thread-safe: a write racing another thread's read of `environ`
//! is undefined behaviour (Rust 2024 makes `set_var` `unsafe` for exactly this reason),
//! and it once made `/bin/sh` vanish from under an unrelated pty test with `ENOENT`.
//! libtest gives every test its own thread — even under `--test-threads=1` — so a
//! thread-local override isolates perfectly and needs no lock at all.
//!
//! Production never sets the override, so `home()` falls through to `$HOME` and the
//! behaviour is unchanged.

use std::path::PathBuf;

#[cfg(test)]
thread_local! {
    static HOME_OVERRIDE: std::cell::RefCell<Option<PathBuf>> =
        const { std::cell::RefCell::new(None) };
}

/// Point this thread's path lookups at `home` for the rest of the test.
#[cfg(test)]
pub fn set_home_for_test(home: impl Into<PathBuf>) {
    HOME_OVERRIDE.with(|h| *h.borrow_mut() = Some(home.into()));
}

fn home() -> Option<PathBuf> {
    #[cfg(test)]
    {
        if let Some(h) = HOME_OVERRIDE.with(|h| h.borrow().clone()) {
            return Some(h);
        }
    }
    std::env::var_os("HOME").map(PathBuf::from)
}

/// `~/.shelly` — the shelly runtime dir.
pub fn shelly_dir() -> Option<PathBuf> {
    home().map(|h| h.join(".shelly"))
}

/// `~/.claude/.credentials.json` — Claude Code's OAuth credentials file, where a
/// login lands on platforms without a Keychain (macOS keeps it in the Keychain).
pub fn claude_credentials_json() -> Option<PathBuf> {
    home().map(|h| h.join(".claude").join(".credentials.json"))
}

/// `~/.claude/projects` — where Claude Code writes session transcripts.
pub fn projects_dir() -> Option<PathBuf> {
    home().map(|h| h.join(".claude").join("projects"))
}

/// `~/.claude/plugins/installed_plugins.json` — Claude Code's record of which plugins
/// are installed, at which version, in which scope. The only place the *installed*
/// plugin version can be read: the plugin runs from a cached snapshot, so neither the
/// repo nor the marketplace says what is actually loaded (see `update.rs`).
pub fn installed_plugins_json() -> Option<PathBuf> {
    home().map(|h| {
        h.join(".claude")
            .join("plugins")
            .join("installed_plugins.json")
    })
}

/// `~/.codex/sessions` — where Codex CLI writes its rollout transcripts
/// (`YYYY/MM/DD/rollout-<timestamp>-<uuid>.jsonl`). Honors `CODEX_HOME` the way
/// Codex itself does; the test override wins over both so sandboxed tests never
/// read a real Codex tree.
pub fn codex_sessions_dir() -> Option<PathBuf> {
    #[cfg(test)]
    {
        if let Some(h) = HOME_OVERRIDE.with(|h| h.borrow().clone()) {
            return Some(h.join(".codex").join("sessions"));
        }
    }
    if let Some(ch) = std::env::var_os("CODEX_HOME") {
        if !ch.is_empty() {
            return Some(PathBuf::from(ch).join("sessions"));
        }
    }
    home().map(|h| h.join(".codex").join("sessions"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_override_redirects_both_dirs() {
        set_home_for_test("/tmp/fake-home");
        assert_eq!(
            shelly_dir().unwrap(),
            PathBuf::from("/tmp/fake-home/.shelly")
        );
        assert_eq!(
            projects_dir().unwrap(),
            PathBuf::from("/tmp/fake-home/.claude/projects")
        );
    }

    #[test]
    fn without_an_override_it_falls_back_to_the_real_home() {
        // Runs on its own thread, so the test above cannot have leaked into it.
        // That isolation is the whole reason this is a thread-local and not a static.
        let real = std::env::var("HOME").unwrap();
        assert!(shelly_dir().unwrap().starts_with(&real));
    }
}
