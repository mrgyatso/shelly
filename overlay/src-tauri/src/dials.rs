// dials.rs — read/write the Companion app dials (mode + quality), the same
// single-word files the plugin hooks + slash-commands use:
//   ~/.claude/companion/mode     agent | manual | selective | always   (default agent)
//   ~/.claude/companion/quality  fast | pretty                          (default fast)
// The Settings panel in the Board reads these to show the current state and writes
// them when the user flips a toggle. Plain files = the plugin observer picks up the
// change on its next job (it reads them per-job), no IPC needed.
use std::path::PathBuf;

/// `~/.claude/companion` — the companion runtime dir.
fn companion_dir() -> Option<PathBuf> {
    std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".claude").join("companion"))
}

#[derive(serde::Serialize)]
pub struct Dials {
    mode: String,
    quality: String,
}

/// Read one dial file, trimmed; fall back to `default` when absent/empty.
fn read_dial(name: &str, default: &str) -> String {
    companion_dir()
        .and_then(|d| std::fs::read_to_string(d.join(name)).ok())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| default.to_string())
}

#[tauri::command]
pub fn read_dials() -> Dials {
    Dials {
        mode: read_dial("mode", "agent"),
        quality: read_dial("quality", "fast"),
    }
}

/// Write a dial. Allow-listed name+value so the UI can't write garbage the
/// plugin would mis-read. Mirrors the slash-command shape (`echo <value> > <file>`).
#[tauri::command]
pub fn set_dial(name: String, value: String) -> Result<(), String> {
    let ok = matches!(
        (name.as_str(), value.as_str()),
        ("mode", "agent" | "manual" | "selective" | "always") | ("quality", "fast" | "pretty")
    );
    if !ok {
        return Err(format!("invalid dial {name}={value}"));
    }
    let dir = companion_dir().ok_or("no HOME")?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    std::fs::write(dir.join(&name), format!("{value}\n")).map_err(|e| e.to_string())
}
