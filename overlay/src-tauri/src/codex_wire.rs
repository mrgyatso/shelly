//! Auto-unlock Codex: wire the Companion marketplace + plugin into a Codex CLI
//! that appeared AFTER setup ran.
//!
//! `companion setup` wires Codex when it's already installed — but a user who
//! installs Codex later shouldn't have to know to re-run setup. On every app
//! launch this checks (on a background thread, best-effort, silent) whether a
//! `codex` binary exists whose config doesn't yet carry our plugin, and adds it.
//!
//! Two guards keep this from ever fighting the user or a contributor:
//!   - the MARKETPLACE is only added when absent — re-adding would repoint a
//!     local dev checkout at GitHub (the same never-re-add rule as setup);
//!   - the PLUGIN is only added when its config key is absent ENTIRELY. A key
//!     with `enabled = false` means someone deliberately turned it off — that
//!     choice is respected, never re-enabled from here.

use std::path::PathBuf;

const MARKETPLACE: &str = "claude-code-companion";
const MARKETPLACE_URL: &str = "https://github.com/mrgyatso/claude-code-companion";
const PLUGIN: &str = "companion@claude-code-companion";

/// `$CODEX_HOME/config.toml`, honoring the same override Codex itself uses.
fn codex_config_path() -> Option<PathBuf> {
    if let Some(ch) = std::env::var_os("CODEX_HOME") {
        if !ch.is_empty() {
            return Some(PathBuf::from(ch).join("config.toml"));
        }
    }
    std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".codex").join("config.toml"))
}

/// What the config already carries. Plain-text containment is enough here: the
/// keys are written by `codex plugin …` itself in a stable shape, and a false
/// negative only costs one redundant (idempotent) CLI call.
fn wired_state(config: &str) -> (bool, bool) {
    let has_marketplace = config.contains(&format!("[marketplaces.{MARKETPLACE}]"));
    let has_plugin = config.contains(&format!("[plugins.\"{PLUGIN}\"]"));
    (has_marketplace, has_plugin)
}

/// Wire Codex if present and not yet wired. Spawned once at app startup; all
/// failure modes are silent (no codex, no network, CLI error) — setup and the
/// docs remain the loud path.
pub fn auto_wire_on_launch() {
    std::thread::spawn(|| {
        let Some(codex) = crate::pty::find_agent("codex") else {
            return;
        };
        let config = codex_config_path()
            .and_then(|p| std::fs::read_to_string(p).ok())
            .unwrap_or_default();
        let (has_marketplace, has_plugin) = wired_state(&config);
        if has_plugin {
            return;
        }
        if !has_marketplace {
            let ok = std::process::Command::new(&codex)
                .args(["plugin", "marketplace", "add", MARKETPLACE_URL])
                .output()
                .map(|o| o.status.success())
                .unwrap_or(false);
            if !ok {
                return;
            }
        }
        let added = std::process::Command::new(&codex)
            .args(["plugin", "add", PLUGIN])
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false);
        if added {
            crate::trace::emit("codex", "auto-wired", &[("plugin", PLUGIN)]);
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wired_state_reads_the_config_codex_writes() {
        let both = r#"
[marketplaces.claude-code-companion]
source = "/somewhere"

[plugins."companion@claude-code-companion"]
enabled = true
"#;
        assert_eq!(wired_state(both), (true, true));

        let mkt_only = "[marketplaces.claude-code-companion]\nsource = \"x\"\n";
        assert_eq!(wired_state(mkt_only), (true, false));

        assert_eq!(wired_state(""), (false, false));
    }

    #[test]
    fn a_disabled_plugin_still_counts_as_wired() {
        // enabled = false is a deliberate user choice — has_plugin must be true so
        // auto-wire never re-adds (and thereby re-enables) it.
        let disabled = "[plugins.\"companion@claude-code-companion\"]\nenabled = false\n";
        assert_eq!(wired_state(disabled), (false, true));
    }
}
