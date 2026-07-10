//! One definition of where the Companion's files live.
//!
//! `dials`, `registry`, `live` and `hub` each carried their own copy of the same
//! `companion_dir()` — three of them byte-for-byte — so there was no single answer to
//! "where is the companion home". They all delegate here now.
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

/// `~/.claude/companion` — the companion runtime dir.
pub fn companion_dir() -> Option<PathBuf> {
    home().map(|h| h.join(".claude").join("companion"))
}

/// `~/.claude/projects` — where Claude Code writes session transcripts.
pub fn projects_dir() -> Option<PathBuf> {
    home().map(|h| h.join(".claude").join("projects"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_override_redirects_both_dirs() {
        set_home_for_test("/tmp/fake-home");
        assert_eq!(
            companion_dir().unwrap(),
            PathBuf::from("/tmp/fake-home/.claude/companion")
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
        assert!(companion_dir().unwrap().starts_with(&real));
    }
}
