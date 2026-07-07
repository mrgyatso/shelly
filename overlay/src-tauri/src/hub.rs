//! Remote-hub client: pull live-state + artifacts from a user-configured hub so
//! offsite agents (e.g. Hermes on a VPS) can drive this overlay.
//!
//! The hub ([`companion-hub`](../../hub)) serves the same on-disk layout the
//! overlay reads locally. Here we GET it over HTTP with a bearer token and feed
//! it into the *existing* pipeline: pulled live-state flows to the live pane
//! (the frontend calls [`read_live_from_hub`] alongside the local read), and
//! pulled artifacts are written into `~/.claude/companion/remote/` — which the
//! native artifact watcher already scans — so they surface through the normal
//! Board ingest path. We nudge it on each new pull with a `board:artifacts-changed`
//! emit (no standalone window — artifacts live only inside the Board shell).
//!
//! Config lives at `~/.claude/companion/hub.json` and is re-read every loop, so
//! `companion hub set …` takes effect without restarting the daemon. Nothing
//! here can panic the daemon: every failure degrades to "skip this tick".

use std::collections::HashSet;
use std::path::PathBuf;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

/// Never poll faster than this, even if a config asks for it.
const POLL_FLOOR_MS: u64 = 1500;
const DEFAULT_INTERVAL_MS: u64 = 4000;
const HTTP_TIMEOUT_SECS: u64 = 8;

#[derive(Clone, Serialize, Deserialize)]
pub struct HubConfig {
    /// Hub base URL — public domain, Tailscale IP, or LAN address. We're
    /// URL-agnostic; the user tells us where to point.
    pub url: String,
    pub token: String,
    #[serde(default = "default_true")]
    pub enabled: bool,
    #[serde(default = "default_interval")]
    pub interval_ms: u64,
}

fn default_true() -> bool {
    true
}
fn default_interval() -> u64 {
    DEFAULT_INTERVAL_MS
}

fn companion_dir() -> Option<PathBuf> {
    std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".claude").join("companion"))
}
fn config_path() -> Option<PathBuf> {
    companion_dir().map(|d| d.join("hub.json"))
}
fn remote_dir() -> Option<PathBuf> {
    companion_dir().map(|d| d.join("remote"))
}

/// Trim a trailing slash so `{base}/api/live` is always well-formed.
fn base(url: &str) -> String {
    url.trim().trim_end_matches('/').to_string()
}

/// A bare filename stem — no separators or `..` — so a hostile manifest can't
/// make us write outside `remote/`.
fn safe_slug(slug: &str) -> bool {
    !slug.is_empty()
        && slug.len() <= 200
        && slug != "."
        && slug != ".."
        && slug
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.')
}

pub fn load_config() -> Option<HubConfig> {
    let raw = std::fs::read_to_string(config_path()?).ok()?;
    serde_json::from_str(&raw).ok()
}

fn save_config(cfg: &HubConfig) -> Result<(), String> {
    let path = config_path().ok_or("no HOME")?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let json = serde_json::to_string_pretty(cfg).map_err(|e| e.to_string())?;
    std::fs::write(&path, json).map_err(|e| e.to_string())
}

/// Blocking GET with a bearer token. Non-2xx is an error carrying the status.
fn http_get(url: &str, token: &str) -> Result<String, String> {
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(HTTP_TIMEOUT_SECS))
        .build()
        .map_err(|e| e.to_string())?;
    let resp = client
        .get(url)
        .bearer_auth(token)
        .send()
        .map_err(|e| e.to_string())?;
    let status = resp.status();
    if !status.is_success() {
        return Err(format!("HTTP {}", status.as_u16()));
    }
    resp.text().map_err(|e| e.to_string())
}

/// Blocking POST of a JSON body with a bearer token. Non-2xx is an error.
fn http_post_json(url: &str, token: &str, body: &serde_json::Value) -> Result<String, String> {
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(HTTP_TIMEOUT_SECS))
        .build()
        .map_err(|e| e.to_string())?;
    // reqwest is built without its `json` feature here; set the body by hand.
    let resp = client
        .post(url)
        .bearer_auth(token)
        .header("content-type", "application/json")
        .body(serde_json::to_string(body).map_err(|e| e.to_string())?)
        .send()
        .map_err(|e| e.to_string())?;
    let status = resp.status();
    if !status.is_success() {
        return Err(format!("HTTP {}", status.as_u16()));
    }
    resp.text().map_err(|e| e.to_string())
}

fn is_active(cfg: &HubConfig) -> bool {
    cfg.enabled && !cfg.url.is_empty() && !cfg.token.is_empty()
}

// ----- Tauri commands ---------------------------------------------------------

/// Live-state JSON pulled from the hub, or `""` if no hub is configured/enabled
/// or the fetch failed. The live pane shows whichever of this and the local
/// `read_live()` is fresher.
#[tauri::command]
pub async fn read_live_from_hub() -> String {
    // Blocking HTTP (reqwest::blocking, up to HTTP_TIMEOUT_SECS against a dead
    // hub) must never run inline on a sync command — Tauri runs those on the main
    // thread, so a slow/unreachable hub freezes the whole UI (beach ball) on every
    // poll. Hand it to a blocking worker so the main thread stays responsive.
    tauri::async_runtime::spawn_blocking(|| match load_config() {
        Some(cfg) if is_active(&cfg) => {
            http_get(&format!("{}/api/live", base(&cfg.url)), &cfg.token).unwrap_or_default()
        }
        _ => String::new(),
    })
    .await
    .unwrap_or_default()
}

#[tauri::command]
pub fn hub_config_get() -> Option<HubConfig> {
    load_config()
}

#[tauri::command]
pub fn hub_config_set(url: String, token: String) -> Result<(), String> {
    save_config(&HubConfig {
        url: base(&url),
        token: token.trim().to_string(),
        enabled: true,
        interval_ms: DEFAULT_INTERVAL_MS,
    })
}

/// Probe a hub: reachability (`/api/health`, unauth) then token validity
/// (`/api/live`). Returns `Ok` only if both pass.
#[tauri::command]
pub async fn hub_test_connection(url: String, token: String) -> Result<String, String> {
    // Blocking HTTP off the main thread — see read_live_from_hub.
    tauri::async_runtime::spawn_blocking(move || {
        let b = base(&url);
        http_get(&format!("{b}/api/health"), &token).map_err(|e| format!("unreachable: {e}"))?;
        http_get(&format!("{b}/api/live"), &token).map_err(|e| format!("token rejected: {e}"))?;
        Ok("connected".to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// The hub's connected-agents manifest (`GET /api/agents` — registration cards
/// merged with liveness), as raw JSON. `""` when no hub is configured or the
/// fetch failed — the Board treats both as "no connected agents".
#[tauri::command]
pub async fn hub_agents() -> String {
    // Blocking HTTP off the main thread — see read_live_from_hub.
    tauri::async_runtime::spawn_blocking(|| match load_config() {
        Some(cfg) if is_active(&cfg) => {
            http_get(&format!("{}/api/agents", base(&cfg.url)), &cfg.token).unwrap_or_default()
        }
        _ => String::new(),
    })
    .await
    .unwrap_or_default()
}

/// Send a reply envelope to a connected agent's hub inbox
/// (`POST /api/inbox/<agent>`). Returns the hub's response — the stored
/// envelope plus delivery outcome (`woken` | `queued` | `wake_failed`).
#[tauri::command]
pub async fn hub_post_inbox(agent: String, payload: serde_json::Value) -> Result<String, String> {
    // Blocking HTTP off the main thread — see read_live_from_hub.
    tauri::async_runtime::spawn_blocking(move || {
        let cfg = load_config().ok_or("no hub configured")?;
        if !is_active(&cfg) {
            return Err("hub disabled".into());
        }
        let slug_ok = !agent.is_empty()
            && agent.len() <= 200
            && agent
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.');
        if !slug_ok {
            return Err("invalid agent id".into());
        }
        http_post_json(
            &format!("{}/api/inbox/{agent}", base(&cfg.url)),
            &cfg.token,
            &payload,
        )
    })
    .await
    .map_err(|e| e.to_string())?
}

// ----- background pull loop ---------------------------------------------------

#[derive(Deserialize)]
struct ManifestEntry {
    slug: String,
    modified_ms: u64,
}

/// Spawn the artifact pull loop on its own thread. It downloads any new hub
/// artifacts into `remote/`; the native artifact watcher already scans that dir,
/// and we also emit `board:artifacts-changed` after a pull so the Board re-scans
/// and surfaces them through the normal ingest path (no standalone window). The
/// live pane pulls separately via [`read_live_from_hub`].
pub fn start_pull_loop(app: AppHandle) {
    std::thread::spawn(move || {
        let mut seen: HashSet<String> = HashSet::new();
        loop {
            let cfg = load_config();
            let interval = cfg
                .as_ref()
                .map(|c| c.interval_ms.max(POLL_FLOOR_MS))
                .unwrap_or(DEFAULT_INTERVAL_MS);
            if let Some(cfg) = cfg {
                if is_active(&cfg) {
                    let _ = poll_once(&app, &cfg, &mut seen);
                }
            }
            std::thread::sleep(Duration::from_millis(interval));
        }
    });
}

fn poll_once(app: &AppHandle, cfg: &HubConfig, seen: &mut HashSet<String>) -> Result<(), String> {
    let b = base(&cfg.url);
    let body = http_get(&format!("{b}/api/artifacts"), &cfg.token)?;
    let manifest: Vec<ManifestEntry> = serde_json::from_str(&body).map_err(|e| e.to_string())?;

    let remote = remote_dir().ok_or("no HOME")?;
    std::fs::create_dir_all(&remote).map_err(|e| e.to_string())?;

    let mut wrote_new = false;
    for entry in &manifest {
        if !safe_slug(&entry.slug) {
            continue;
        }
        let key = format!("{}:{}", entry.slug, entry.modified_ms);
        if seen.contains(&key) {
            continue;
        }
        let html = match http_get(&format!("{b}/api/artifacts/{}", entry.slug), &cfg.token) {
            Ok(h) => h,
            Err(_) => continue, // transient; retry next tick (not marked seen)
        };
        let dest = remote.join(format!("{}.html", entry.slug));
        if std::fs::write(&dest, html).is_err() {
            continue;
        }
        seen.insert(key);
        wrote_new = true;
    }

    // Surface freshly pulled artifacts: wake the Board's poll so it re-scans
    // `remote/` and ingests them through the normal pipeline. The native watcher
    // would catch them within its scan interval anyway; this just removes that lag.
    if wrote_new {
        let _ = app.emit("board:artifacts-changed", ());
    }

    Ok(())
}
