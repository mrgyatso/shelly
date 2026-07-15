//! Account-wide rate-limit usage, from Anthropic's OAuth usage endpoint.
//!
//! Claude subscriptions meter usage in rolling windows — a 5-hour window and a
//! 7-day window — and `GET https://api.anthropic.com/api/oauth/usage` reports how
//! full each one is, as a direct 0–100 percentage plus the instant the window
//! resets. The call is authenticated with Claude Code's own OAuth access token,
//! which lives in the macOS Keychain under `Claude Code-credentials` (Claude Code
//! writes it there at login) or in `~/.claude/.credentials.json` on Linux.
//!
//! This is ACCOUNT state, not session state — one number for the whole Board, so
//! one cache for the whole process:
//!
//!   * A successful response is cached for `CACHE_TTL` (5 min). The frontend can
//!     poll as often as it likes; only one HTTP request goes out per window.
//!   * A 429 opens a backoff window honoring `retry-after` (min 2 min). A 401/403
//!     opens a long one — the token is invalid and only a re-login fixes it, so
//!     re-asking every poll is pure noise.
//!   * Any error falls back to the last good reading (stale beats blank on a
//!     meter that moves in percents per hour), and `None` only when there has
//!     never been one.

use std::sync::Mutex;
use std::time::{Duration, Instant};

/// One rolling window's position.
#[derive(serde::Serialize, serde::Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct RateBucket {
    /// Direct percentage, 0–100 (the API returns e.g. `60.0` for 60%).
    pub utilization: f64,
    /// ISO8601 instant the window resets; absent when no window is active.
    #[serde(alias = "resets_at")]
    pub resets_at: Option<String>,
}

/// What the frontend paints. Only the two windows the pill shows — the endpoint
/// returns more buckets (per-model weeklies, overage credits) that nothing reads.
#[derive(serde::Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct RateLimitUsage {
    pub five_hour: Option<RateBucket>,
    pub seven_day: Option<RateBucket>,
}

const USAGE_URL: &str = "https://api.anthropic.com/api/oauth/usage";
const CACHE_TTL: Duration = Duration::from_secs(300);
/// Floor for the 429 backoff — never hammer faster than this after a rate limit.
const RATE_LIMIT_BACKOFF: Duration = Duration::from_secs(120);
/// Backoff after 401/403 — the token is bad until the user logs in again.
const AUTH_BACKOFF: Duration = Duration::from_secs(30 * 60);

struct CacheState {
    last_good: Option<RateLimitUsage>,
    fresh_until: Option<Instant>,
    backoff_until: Option<Instant>,
}

static STATE: Mutex<CacheState> = Mutex::new(CacheState {
    last_good: None,
    fresh_until: None,
    backoff_until: None,
});

/// Read Claude Code's OAuth access token. macOS: Keychain first (that's where a
/// logged-in Claude Code puts it), then the JSON file. Elsewhere: the file.
fn read_access_token() -> Option<String> {
    #[cfg(target_os = "macos")]
    if let Some(json) = read_keychain_json() {
        if let Some(token) = token_from_credentials_json(&json) {
            return Some(token);
        }
    }
    let path = crate::paths::claude_credentials_json()?;
    let json = std::fs::read_to_string(path).ok()?;
    token_from_credentials_json(&json)
}

#[cfg(target_os = "macos")]
fn read_keychain_json() -> Option<String> {
    let out = std::process::Command::new("security")
        .args(["find-generic-password", "-s", "Claude Code-credentials", "-w"])
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let raw = String::from_utf8_lossy(&out.stdout).trim().to_string();
    (!raw.is_empty()).then_some(raw)
}

/// Pull `claudeAiOauth.accessToken` out of the credentials JSON.
fn token_from_credentials_json(json: &str) -> Option<String> {
    let v: serde_json::Value = serde_json::from_str(json).ok()?;
    v.get("claudeAiOauth")?
        .get("accessToken")?
        .as_str()
        .map(String::from)
}

/// Parse the endpoint's response body down to the two buckets the pill shows.
fn parse_usage_body(body: &str) -> Option<RateLimitUsage> {
    let v: serde_json::Value = serde_json::from_str(body).ok()?;
    let bucket = |key: &str| -> Option<RateBucket> {
        serde_json::from_value(v.get(key)?.clone()).ok()
    };
    Some(RateLimitUsage {
        five_hour: bucket("five_hour"),
        seven_day: bucket("seven_day"),
    })
}

/// The blocking fetch + cache/backoff bookkeeping. Runs on a blocking thread.
fn fetch_rate_limit_usage() -> Option<RateLimitUsage> {
    {
        let s = STATE.lock().unwrap();
        let now = Instant::now();
        if let (Some(fresh_until), Some(good)) = (s.fresh_until, s.last_good.as_ref()) {
            if now < fresh_until {
                return Some(good.clone());
            }
        }
        if let Some(until) = s.backoff_until {
            if now < until {
                return s.last_good.clone();
            }
        }
    }

    let token = read_access_token()?;
    let resp = reqwest::blocking::Client::new()
        .get(USAGE_URL)
        .header("Authorization", format!("Bearer {token}"))
        .header("anthropic-beta", "oauth-2025-04-20")
        .timeout(Duration::from_secs(15))
        .send();

    let mut s = STATE.lock().unwrap();
    match resp {
        Ok(r) => {
            let status = r.status();
            if status.is_success() {
                let parsed = r.text().ok().as_deref().and_then(parse_usage_body);
                if let Some(usage) = parsed {
                    s.last_good = Some(usage.clone());
                    s.fresh_until = Some(Instant::now() + CACHE_TTL);
                    s.backoff_until = None;
                    return Some(usage);
                }
                // Parsed nothing usable — the API shape moved. Back off a cache
                // interval so we don't re-parse the same surprise every poll.
                s.backoff_until = Some(Instant::now() + CACHE_TTL);
            } else if status.as_u16() == 429 {
                let retry_after = r
                    .headers()
                    .get("retry-after")
                    .and_then(|v| v.to_str().ok())
                    .and_then(|v| v.parse::<u64>().ok())
                    .map(Duration::from_secs)
                    .unwrap_or(RATE_LIMIT_BACKOFF);
                s.backoff_until = Some(Instant::now() + retry_after.max(RATE_LIMIT_BACKOFF));
            } else if status.as_u16() == 401 || status.as_u16() == 403 {
                s.backoff_until = Some(Instant::now() + AUTH_BACKOFF);
            } else {
                s.backoff_until = Some(Instant::now() + RATE_LIMIT_BACKOFF);
            }
        }
        // Network error (offline, DNS): short backoff, keep serving the stale reading.
        Err(_) => s.backoff_until = Some(Instant::now() + RATE_LIMIT_BACKOFF),
    }
    s.last_good.clone()
}

/// Account-wide rate-limit usage for the Board's 5h pill. `None` means "nothing
/// to show" (no token, or no reading has ever succeeded) — the pill hides.
#[tauri::command]
pub async fn rate_limit_usage() -> Option<RateLimitUsage> {
    tauri::async_runtime::spawn_blocking(fetch_rate_limit_usage)
        .await
        .ok()
        .flatten()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_live_response_shape() {
        // Trimmed from a real 2026-07 response — extra buckets and unknown
        // fields must be tolerated, not fatal.
        let body = r#"{
            "five_hour": {"utilization": 60.0, "resets_at": "2026-07-14T17:39:59.949740+00:00",
                          "limit_dollars": null, "used_dollars": null},
            "seven_day": {"utilization": 3.0, "resets_at": "2026-07-21T15:59:59.949765+00:00"},
            "seven_day_opus": null,
            "tangelo": null,
            "extra_usage": {"is_enabled": false},
            "limits": [{"kind": "session", "percent": 60}]
        }"#;
        let usage = parse_usage_body(body).expect("parses");
        let five = usage.five_hour.expect("five_hour present");
        assert_eq!(five.utilization, 60.0);
        assert_eq!(five.resets_at.as_deref(), Some("2026-07-14T17:39:59.949740+00:00"));
        assert_eq!(usage.seven_day.expect("seven_day present").utilization, 3.0);
    }

    #[test]
    fn tolerates_null_buckets_and_garbage() {
        let usage = parse_usage_body(r#"{"five_hour": null, "seven_day": null}"#).expect("parses");
        assert!(usage.five_hour.is_none());
        assert!(usage.seven_day.is_none());
        assert!(parse_usage_body("not json").is_none());
    }

    #[test]
    fn extracts_token_from_credentials_json() {
        let json = r#"{"claudeAiOauth": {"accessToken": "sk-ant-oat01-abc", "subscriptionType": "max"}}"#;
        assert_eq!(token_from_credentials_json(json).as_deref(), Some("sk-ant-oat01-abc"));
        assert!(token_from_credentials_json(r#"{"other": true}"#).is_none());
        assert!(token_from_credentials_json("").is_none());
    }
}
