//! Hub configuration, resolved from the environment at startup.
//!
//! Everything has a sensible default so `companion-hub` runs with zero flags:
//! it serves `~/.claude/companion/` (the same dir the agent already writes) on
//! port 8787, generating + persisting a token on first run.

use std::io;
use std::path::{Path, PathBuf};

pub struct Config {
    /// Directory holding `*.html` artifacts.
    pub artifacts_dir: PathBuf,
    /// Directory holding per-project `*.json` live-state files.
    pub live_dir: PathBuf,
    /// Directory holding routine-state `*.json` files.
    pub routines_dir: PathBuf,
    /// Directory holding agent registration cards (`agents/<id>.json`).
    pub agents_dir: PathBuf,
    /// Directory holding per-agent reply queues (`inbox/<agent>/*.json`).
    pub inbox_dir: PathBuf,
    /// Shared bearer token required on every `/api/*` request (except health).
    pub token: String,
    /// Address to bind. Default `0.0.0.0` (all interfaces). Set
    /// `COMPANION_HUB_BIND` to a specific IP — e.g. your Tailscale IP — so the
    /// hub is reachable only over that interface (the tailnet), not the LAN.
    pub bind: String,
    /// TCP port to bind.
    pub port: u16,
    /// Directory of the static web UI served at `/`.
    pub webui_dir: PathBuf,
}

fn home() -> PathBuf {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_default()
}

/// Prefer a `webui` dir next to the binary (how it ships), else `./webui`.
fn default_webui_dir() -> PathBuf {
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            let candidate = dir.join("webui");
            if candidate.is_dir() {
                return candidate;
            }
        }
    }
    PathBuf::from("webui")
}

impl Config {
    pub fn load() -> io::Result<Self> {
        let data_dir = std::env::var_os("COMPANION_HUB_DATA_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|| home().join(".claude").join("companion"));

        let artifacts_dir = std::env::var_os("COMPANION_ARTIFACTS_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|| data_dir.join("artifacts"));
        let live_dir = data_dir.join("live");
        let routines_dir = data_dir.join("routines");
        let agents_dir = data_dir.join("agents");
        let inbox_dir = data_dir.join("inbox");

        let port = std::env::var("COMPANION_HUB_PORT")
            .ok()
            .and_then(|p| p.trim().parse().ok())
            .unwrap_or(8787);

        let bind = std::env::var("COMPANION_HUB_BIND")
            .ok()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| "0.0.0.0".to_string());

        let webui_dir = std::env::var_os("COMPANION_HUB_WEBUI_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(default_webui_dir);

        let token = load_or_create_token(&data_dir)?;

        Ok(Self {
            artifacts_dir,
            live_dir,
            routines_dir,
            agents_dir,
            inbox_dir,
            token,
            bind,
            port,
            webui_dir,
        })
    }
}

/// Resolve the bearer token: explicit env wins; else a persisted token file;
/// else generate one, persist it `0600`, and return it. The caller prints the
/// pairing string.
fn load_or_create_token(data_dir: &Path) -> io::Result<String> {
    if let Ok(t) = std::env::var("COMPANION_HUB_TOKEN") {
        let t = t.trim().to_string();
        if !t.is_empty() {
            return Ok(t);
        }
    }

    let token_path = data_dir.join("hub-token");
    if let Ok(existing) = std::fs::read_to_string(&token_path) {
        let existing = existing.trim().to_string();
        if !existing.is_empty() {
            return Ok(existing);
        }
    }

    let token = generate_token()?;
    std::fs::create_dir_all(data_dir)?;
    std::fs::write(&token_path, &token)?;
    restrict_permissions(&token_path);
    Ok(token)
}

/// 32 random bytes from the OS CSPRNG, hex-encoded — no crate needed.
fn generate_token() -> io::Result<String> {
    use std::io::Read;
    let mut buf = [0u8; 32];
    std::fs::File::open("/dev/urandom")?.read_exact(&mut buf)?;
    Ok(buf.iter().map(|b| format!("{b:02x}")).collect())
}

/// Best-effort `chmod 600` on the token file (Unix only).
fn restrict_permissions(path: &Path) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600));
    }
    #[cfg(not(unix))]
    {
        let _ = path;
    }
}
