//! One lock for every test that touches the process environment.
//!
//! `std::env::set_var` is not thread-safe. A write racing another thread's read
//! of `environ` is undefined behaviour — Rust 2024 makes `set_var` `unsafe` for
//! exactly this reason, and we are only on 2021 by accident of timing.
//!
//! The reads are not always visible in the test that suffers: spawning a process
//! reads the environment to build the child's `envp`, so a `set_var` in one test
//! could make `/bin/sh` vanish from under an unrelated pty test with `ENOENT`.
//!
//! So the rule is broader than "lock the writers": any test that mutates the
//! environment, or spawns a process, must hold this lock.

use std::sync::{Mutex, MutexGuard};

pub fn env_lock() -> MutexGuard<'static, ()> {
    static LOCK: Mutex<()> = Mutex::new(());
    // A test that panics while holding the lock poisons it. That failure is
    // already reported; don't cascade it into every other env-touching test.
    LOCK.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}
