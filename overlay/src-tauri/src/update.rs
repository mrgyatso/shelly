//! update.rs — "what am I running, is there a newer one, and update me."
//!
//! Shelly is **two independently-rotting halves**, and this is the one place that
//! knows both:
//!
//!   * the **app** — this binary. Installed by the Homebrew cask (macOS) or a `.deb`
//!     (Linux), and moved forward only by `install.sh`. A newer release never reaches
//!     an installed machine on its own.
//!   * the **plugin** — the Claude Code side (hooks, skills, `/shelly:*`). Moved by
//!     `claude plugin update`, which `shelly setup` runs. It executes from a *cached
//!     snapshot*, so it can sit stale indefinitely with nothing in the UI saying so.
//!
//! An app-only updater would leave the second half rotting, which is the half users
//! actually feel. So the Update button runs `shelly-update`, which does both, on
//! both platforms — the same work `install.sh` already does when you re-run it.
//!
//! The status probe reaches GitHub. That MUST NOT happen on a sync command: Tauri runs
//! those on the main thread, and a slow endpoint freezes the whole Board (which is
//! exactly how a dead hub once beach-balled it for ten seconds a click). Hence
//! `async` + `spawn_blocking`, the same shape as `hub.rs`.

use std::path::PathBuf;
use std::time::Duration;

const RELEASES_LATEST: &str =
    "https://api.github.com/repos/mrgyatso/shelly/releases/latest";
const HTTP_TIMEOUT_SECS: u64 = 8;

/// The plugin as Claude Code records it. One key, many entries — the plugin is
/// installed per *project*, so a machine legitimately holds several versions at once.
const PLUGIN_KEY: &str = "shelly@shelly";

#[derive(serde::Serialize, Default)]
pub struct UpdateStatus {
    /// The running app's version (from tauri.conf.json, baked in at build time).
    pub app: String,
    /// Newest installed plugin version, or `None` when the plugin isn't installed.
    pub plugin: Option<String>,
    /// Newest released version, or `None` when GitHub was unreachable. `None` is not
    /// "up to date" — the UI must say "couldn't check", never invent good news.
    pub latest: Option<String>,
    /// The app is strictly behind the latest release.
    pub behind: bool,
}

/// Compare two dotted numeric versions. `true` when `a` is strictly older than `b`.
///
/// Deliberately not a semver crate: these are our own tags (`0.7.1`), always numeric,
/// and a whole dependency to compare three integers is not worth it. Non-numeric
/// components sort as 0, so a garbage version reads as older and the worst case is an
/// update offered needlessly — never an update silently withheld.
fn is_older(a: &str, b: &str) -> bool {
    let part = |s: &str| -> Vec<u64> {
        s.split('.')
            .map(|c| c.trim().parse::<u64>().unwrap_or(0))
            .collect()
    };
    let (va, vb) = (part(a), part(b));
    for i in 0..va.len().max(vb.len()) {
        let (x, y) = (
            va.get(i).copied().unwrap_or(0),
            vb.get(i).copied().unwrap_or(0),
        );
        if x != y {
            return x < y;
        }
    }
    false
}

/// The newest Shelly plugin version Claude Code has installed, across every scope.
///
/// The file maps a plugin key to an *array* of installs (one per project scope), which
/// can disagree — a machine can hold 0.4.4 for one repo and 0.5.0 for another. The
/// newest is the honest single number to show: it is what a fully-updated machine has,
/// so anything less means `shelly setup` has work to do.
fn installed_plugin_version() -> Option<String> {
    let raw = std::fs::read_to_string(crate::paths::installed_plugins_json()?).ok()?;
    let json: serde_json::Value = serde_json::from_str(&raw).ok()?;
    let entries = json.get("plugins")?.get(PLUGIN_KEY)?.as_array()?;
    entries
        .iter()
        .filter_map(|e| e.get("version")?.as_str())
        .filter(|v| !v.is_empty() && *v != "unknown")
        .map(String::from)
        .reduce(|a, b| if is_older(&a, &b) { b } else { a })
}

/// The newest published release's version, with the tag's leading `v` stripped.
///
/// `/releases/latest` **excludes prereleases** — and our release workflow creates a
/// missing release *as* a prerelease, so a build that has not been promoted by hand
/// stays invisible here. That is deliberate: the updater must never offer a build we
/// deliberately hid. (`install.sh` resolves its download the same way.)
fn latest_released_version() -> Option<String> {
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(HTTP_TIMEOUT_SECS))
        .build()
        .ok()?;
    // GitHub rejects a request with no User-Agent outright (403).
    let body = client
        .get(RELEASES_LATEST)
        .header("User-Agent", "shelly")
        .send()
        .ok()?
        .error_for_status()
        .ok()?
        .text()
        .ok()?;
    let json: serde_json::Value = serde_json::from_str(&body).ok()?;
    let tag = json.get("tag_name")?.as_str()?;
    Some(tag.trim_start_matches('v').to_string())
}

/// Both versions plus whether a newer app exists. Never fails: an unreachable GitHub
/// leaves `latest: None`, which the UI renders as "couldn't check", not "up to date".
#[tauri::command]
pub async fn update_status(app: tauri::AppHandle) -> UpdateStatus {
    let running = app.package_info().version.to_string();
    // The network call goes to a blocking worker — see the module note.
    tauri::async_runtime::spawn_blocking(move || {
        let latest = latest_released_version();
        let behind = latest
            .as_deref()
            .map(|l| is_older(&running, l))
            .unwrap_or(false);
        UpdateStatus {
            app: running,
            plugin: installed_plugin_version(),
            latest,
            behind,
        }
    })
    .await
    .unwrap_or_default()
}

/// Where the bundled CLI scripts live, resolved from the running binary.
///
/// Not from `PATH`: a GUI-launched app on macOS inherits launchd's minimal PATH
/// (`/usr/bin:/bin:/usr/sbin:/sbin`), which does not contain `/usr/local/bin` — so the
/// `shelly` symlink the installer creates is invisible to us. The bundle layout is.
fn scripts_dir() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let dir = exe.parent()?;
    // macOS: …/Contents/MacOS/shelly → …/Contents/Resources/scripts
    // Linux: /usr/bin/shelly        → /usr/lib/shelly/scripts
    // Dev:   target/{debug,release}/…          → ../../../scripts
    let candidates = [
        dir.join("../Resources/scripts"),
        PathBuf::from("/usr/lib/shelly/scripts"),
        dir.join("../../../scripts"),
    ];
    candidates
        .iter()
        .map(|p| p.join("shelly-update"))
        .find(|p| p.is_file())
        .and_then(|p| p.parent().map(PathBuf::from))
}

/// Kick off the update and return immediately.
///
/// The helper is **copied to a temp dir and run from there**, detached, and it is handed
/// our PID so it can wait for us to exit before touching the bundle. Three reasons, all
/// load-bearing:
///
///   1. **Bash reads a script incrementally.** `brew upgrade` deletes and replaces the
///      whole `.app` — including the helper, if it were still executing from inside it.
///      The interpreter would then read the rest of its own script from a file that no
///      longer exists. (Same class of bug as the `curl | bash` stdin trap in install.sh:
///      the script is not loaded up front, so anything that moves it out from under bash
///      mid-run truncates it silently.)
///   2. **The cask quits us on upgrade** (`uninstall quit:`), so a child sharing our
///      process group would die mid-swap. `setsid` puts the helper in its own session.
///   3. **We cannot replace ourselves while running.** The helper waits for our PID to
///      go, does the work, and launches the new build.
#[tauri::command]
pub fn run_update(app: tauri::AppHandle) -> Result<(), String> {
    let src = scripts_dir()
        .map(|d| d.join("shelly-update"))
        .filter(|p| p.is_file())
        .ok_or("could not find the bundled shelly-update script")?;

    // A fixed name in the temp dir, overwritten each run: the helper is short-lived and
    // a stale copy from a failed attempt should simply be replaced.
    let dst = std::env::temp_dir().join("shelly-update");
    std::fs::copy(&src, &dst).map_err(|e| format!("could not stage the updater: {e}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&dst, std::fs::Permissions::from_mode(0o755))
            .map_err(|e| format!("could not make the updater executable: {e}"))?;
    }

    let pid = std::process::id().to_string();
    // setsid detaches into a new session, so quitting this app cannot take the helper
    // with it. Where setsid is absent (it is not on macOS) the double-fork equivalent
    // is `sh -c '… &'`, which reparents to init once this process goes.
    // `setsid` where it exists (Linux), a plain background job otherwise (macOS has no
    // setsid): either way `&` reparents the helper to init the moment we exit, so
    // quitting this app cannot take its own updater down with it.
    std::process::Command::new("/bin/sh")
        .arg("-c")
        .arg(format!(
            "if command -v setsid >/dev/null 2>&1; then \
               setsid {sh} {pid} >/dev/null 2>&1 & \
             else \
               {sh} {pid} >/dev/null 2>&1 & \
             fi",
            sh = shell_quote(&dst.to_string_lossy()),
            pid = pid
        ))
        .spawn()
        .map_err(|e| format!("could not start the updater: {e}"))?;

    // Quit, so the helper can replace us — it is blocked on our PID.
    //
    // On macOS the cask would quit us anyway (`uninstall quit:`), but Linux's dpkg
    // would not, and then the helper would wait out its full timeout on a process that
    // is never going to exit. Quitting here makes both platforms one story: the app
    // closes, updates, and reopens.
    //
    // `exit(0)` and not a window close: only an *explicit* exit is honoured — a closed
    // window keeps the daemon alive by design (see the RunEvent handler in lib.rs), and
    // a live daemon holds the single-instance socket, which is precisely what makes an
    // app un-upgradable.
    //
    // The delay lets this command's reply reach the webview so the button can paint its
    // "updating…" state; without it the window dies mid-IPC and the click looks dropped.
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(900));
        app.exit(0);
    });

    Ok(())
}

/// Single-quote a path for `/bin/sh`. Paths here come from our own bundle, but the
/// bundle can sit under a user directory with a space in it, and the app name has one.
fn shell_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', r"'\''"))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A fresh HOME per test, with the plugin manifest written into it. Named by pid +
    /// a counter, never by timestamp: `SystemTime` is only µs-resolved on macOS, so
    /// timestamp-named dirs collide under `cargo test`'s thread pool (that collision is
    /// half of what once made this suite flaky).
    fn home_with_plugins(manifest: &str) -> PathBuf {
        static N: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
        let n = N.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let home = std::env::temp_dir().join(format!("cmp-upd-{}-{n}", std::process::id()));
        let dir = home.join(".claude").join("plugins");
        let _ = std::fs::remove_dir_all(&home);
        std::fs::create_dir_all(&dir).unwrap();
        if !manifest.is_empty() {
            std::fs::write(dir.join("installed_plugins.json"), manifest).unwrap();
        }
        home
    }

    #[test]
    fn a_lower_patch_is_older() {
        assert!(is_older("0.7.0", "0.7.1"));
        assert!(!is_older("0.7.1", "0.7.0"));
    }

    #[test]
    fn the_same_version_is_not_older_than_itself() {
        // The whole point of the flag: an up-to-date app must not be offered an update.
        assert!(!is_older("0.7.1", "0.7.1"));
    }

    #[test]
    fn components_compare_numerically_not_as_text() {
        // "0.10.0" < "0.9.0" as strings, which is the classic way this goes wrong.
        assert!(is_older("0.9.0", "0.10.0"));
        assert!(!is_older("0.10.0", "0.9.0"));
    }

    #[test]
    fn a_missing_component_counts_as_zero() {
        assert!(is_older("0.7", "0.7.1"));
        assert!(!is_older("0.7.0", "0.7"));
    }

    #[test]
    fn the_newest_installed_plugin_wins_across_scopes() {
        // Claude Code installs the plugin per project, so several versions coexist on
        // one machine. The newest is what a fully-updated machine has — anything less
        // means `shelly setup` still has work to do. Note 0.10.0 sitting below
        // 0.4.4: this also pins that the pick is numeric, not lexical.
        let home = home_with_plugins(
            r#"{"plugins":{"shelly@shelly":[
                 {"version":"0.4.4"},{"version":"0.10.0"},{"version":"0.4.9"}]}}"#,
        );
        crate::paths::set_home_for_test(&home);
        assert_eq!(installed_plugin_version().as_deref(), Some("0.10.0"));
    }

    #[test]
    fn an_unknown_plugin_version_is_ignored_not_shown() {
        // Claude Code writes "unknown" when it cannot read a version (there is one in
        // this machine's real manifest). Rendering that verbatim in Settings would be
        // worse than rendering nothing.
        let home = home_with_plugins(
            r#"{"plugins":{"shelly@shelly":[{"version":"unknown"}]}}"#,
        );
        crate::paths::set_home_for_test(&home);
        assert_eq!(installed_plugin_version(), None);
    }

    #[test]
    fn no_plugin_installed_reads_as_none_not_as_an_error() {
        let home = home_with_plugins("");
        crate::paths::set_home_for_test(&home);
        assert_eq!(installed_plugin_version(), None);
    }

    #[test]
    fn a_path_with_a_space_survives_the_shell() {
        // "/Applications/Shelly.app/…" — the common case, not an edge case.
        assert_eq!(
            shell_quote("/Applications/Shelly.app/x"),
            "'/Applications/Shelly.app/x'"
        );
    }
}
