//! The connected-agents layer: registry, liveness, and the reply inbox.
//!
//! An *agent* is any autonomous worker (a Hermes cron, an OpenClaw-style
//! gateway, a bare script) that publishes Companion surfaces — live-state JSON
//! and HTML artifacts — under this hub's data dir. The registry gives each one
//! a durable identity card (`agents/<id>.json`); the inbox gives the user a
//! reply path (`inbox/<agent>/<envelope>.json`) so interacting with an agent's
//! artifact on the Board round-trips back to the agent.
//!
//! Identity contract (one key, three places): an agent's `id` is its live-file
//! slug (`live/<id>.json`) and its artifacts' `companion-meta.project`. That is
//! how liveness and artifact counts are attributed — no second derivation.
//!
//! Everything is file-backed, like the rest of the hub: co-located agents may
//! read/write these files directly and skip HTTP entirely; remote agents get
//! the same shapes over the token-gated API.

use std::path::{Path, PathBuf};

use crate::data::{list_artifacts, modified_ms, now_ms, safe_slug};

/// Cap inbox listings so a runaway producer can't balloon a poll response.
const INBOX_LIST_MAX: usize = 200;

/// One agent's registration card, as stored at `agents/<id>.json`.
#[derive(serde::Serialize, serde::Deserialize, Clone, Debug, PartialEq)]
pub struct AgentReg {
    pub id: String,
    pub name: String,
    pub emoji: Option<String>,
    pub tagline: Option<String>,
    #[serde(default)]
    pub capabilities: Vec<String>,
    /// argv spawned on each inbox delivery, with the envelope path appended.
    /// Only the bearer-token holder can set this — the hub's existing trust
    /// boundary. `None` means envelopes just queue for the agent's next run.
    pub wake: Option<Vec<String>>,
    pub registered_ms: u64,
    pub updated_ms: u64,
}

/// Upsert body for `PUT /api/agents/<id>`.
#[derive(serde::Deserialize, Clone, Debug)]
pub struct AgentUpsert {
    pub name: Option<String>,
    pub emoji: Option<String>,
    pub tagline: Option<String>,
    #[serde(default)]
    pub capabilities: Vec<String>,
    pub wake: Option<Vec<String>>,
}

/// One agent as surfaced by `GET /api/agents`: the registration plus liveness
/// derived from its live file and artifacts.
#[derive(serde::Serialize, Clone, Debug)]
pub struct AgentInfo {
    #[serde(flatten)]
    pub reg: AgentReg,
    /// Freshest sign of life: max(registration update, live-file mtime,
    /// newest owned artifact mtime). Epoch millis; 0 = never.
    pub last_seen_ms: u64,
    /// The agent's current `working` line from `live/<id>.json`, if any.
    pub working: Option<String>,
    /// How many artifacts in the hub's dir carry this agent's id as project.
    pub artifact_count: u64,
}

/// One queued reply envelope, as stored at `inbox/<agent>/<id>.json`.
#[derive(serde::Serialize, serde::Deserialize, Clone, Debug, PartialEq)]
pub struct InboxEnvelope {
    pub id: String,
    pub agent: String,
    pub received_ms: u64,
    /// The sender's payload, verbatim — review-form results, a freeform note,
    /// an action click. The hub does not interpret it.
    pub payload: serde_json::Value,
}

/// Outcome of `POST /api/inbox/<agent>`, so the sender knows whether the agent
/// was woken immediately or will pick the envelope up on its next run.
#[derive(serde::Serialize, Debug, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum Delivery {
    Woken,
    Queued,
    /// A wake command was configured but failed to spawn; the envelope is
    /// still safely queued on disk.
    WakeFailed,
}

#[derive(Debug, PartialEq)]
pub enum AgentError {
    InvalidId,
    NotFound,
    Io(String),
}

fn agent_path(agents_dir: &Path, id: &str) -> Option<PathBuf> {
    Some(agents_dir.join(format!("{}.json", safe_slug(id)?)))
}

pub fn read_agent(agents_dir: &Path, id: &str) -> Option<AgentReg> {
    let raw = std::fs::read_to_string(agent_path(agents_dir, id)?).ok()?;
    serde_json::from_str(&raw).ok()
}

/// Upsert `agents/<id>.json`. First write stamps `registered_ms`; later writes
/// preserve it and bump `updated_ms`. `name` defaults to the id.
pub fn write_agent(
    agents_dir: &Path,
    id: &str,
    input: AgentUpsert,
) -> Result<AgentReg, AgentError> {
    let id = safe_slug(id).ok_or(AgentError::InvalidId)?;
    let path = agent_path(agents_dir, id).ok_or(AgentError::InvalidId)?;
    std::fs::create_dir_all(agents_dir).map_err(|e| AgentError::Io(format!("agents dir: {e}")))?;

    let prior = read_agent(agents_dir, id);
    let now = now_ms();
    let reg = AgentReg {
        id: id.to_string(),
        name: input.name.unwrap_or_else(|| id.to_string()),
        emoji: input.emoji,
        tagline: input.tagline,
        capabilities: input.capabilities,
        wake: input.wake,
        registered_ms: prior.map(|p| p.registered_ms).unwrap_or(now),
        updated_ms: now,
    };
    let json = serde_json::to_string_pretty(&reg)
        .map_err(|e| AgentError::Io(format!("serialize: {e}")))?;
    std::fs::write(&path, json).map_err(|e| AgentError::Io(format!("write: {e}")))?;
    Ok(reg)
}

/// Liveness for one agent id: live-file mtime + `working` line, and how many
/// artifacts it owns (by `companion-meta.project`).
fn liveness(live_dir: &Path, artifacts_dir: &Path, id: &str) -> (u64, Option<String>, u64) {
    let live_path = live_dir.join(format!("{id}.json"));
    let live_mtime = std::fs::metadata(&live_path)
        .map(|m| modified_ms(&m))
        .unwrap_or(0);
    let working = std::fs::read_to_string(&live_path)
        .ok()
        .and_then(|raw| serde_json::from_str::<serde_json::Value>(&raw).ok())
        .and_then(|v| v.get("working").and_then(|w| w.as_str()).map(String::from));

    let mut count = 0u64;
    let mut newest = 0u64;
    for entry in list_artifacts(artifacts_dir) {
        if entry.project.as_deref() == Some(id) {
            count += 1;
            newest = newest.max(entry.modified_ms);
        }
    }
    (live_mtime.max(newest), working, count)
}

/// Every registered agent, enriched with liveness, freshest first.
pub fn list_agents(agents_dir: &Path, live_dir: &Path, artifacts_dir: &Path) -> Vec<AgentInfo> {
    let mut agents: Vec<AgentInfo> = std::fs::read_dir(agents_dir)
        .into_iter()
        .flatten()
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .filter(|p| p.extension().and_then(|e| e.to_str()) == Some("json"))
        .filter_map(|p| std::fs::read_to_string(p).ok())
        .filter_map(|raw| serde_json::from_str::<AgentReg>(&raw).ok())
        .map(|reg| {
            let (seen, working, artifact_count) = liveness(live_dir, artifacts_dir, &reg.id);
            AgentInfo {
                last_seen_ms: seen.max(reg.updated_ms),
                working,
                artifact_count,
                reg,
            }
        })
        .collect();
    agents.sort_by_key(|a| std::cmp::Reverse(a.last_seen_ms));
    agents
}

pub fn get_agent_info(
    agents_dir: &Path,
    live_dir: &Path,
    artifacts_dir: &Path,
    id: &str,
) -> Option<AgentInfo> {
    let reg = read_agent(agents_dir, id)?;
    let (seen, working, artifact_count) = liveness(live_dir, artifacts_dir, id);
    Some(AgentInfo {
        last_seen_ms: seen.max(reg.updated_ms),
        working,
        artifact_count,
        reg,
    })
}

// ----- inbox --------------------------------------------------------------------

fn inbox_dir_for(inbox_dir: &Path, agent: &str) -> Option<PathBuf> {
    Some(inbox_dir.join(safe_slug(agent)?))
}

/// Queue one envelope for `agent` and, if its registration carries a wake
/// command, spawn it detached with the envelope path appended. The write always
/// happens first — a wake failure can never lose the reply.
pub fn deliver(
    inbox_dir: &Path,
    agents_dir: &Path,
    agent: &str,
    payload: serde_json::Value,
) -> Result<(InboxEnvelope, Delivery), AgentError> {
    let agent = safe_slug(agent).ok_or(AgentError::InvalidId)?;
    let dir = inbox_dir_for(inbox_dir, agent).ok_or(AgentError::InvalidId)?;
    std::fs::create_dir_all(&dir).map_err(|e| AgentError::Io(format!("inbox dir: {e}")))?;

    let now = now_ms();
    // ms timestamp + pid keeps ids unique enough for a single-user queue while
    // staying sortable by arrival.
    let id = format!("{now}-{}", std::process::id());
    let envelope = InboxEnvelope {
        id: id.clone(),
        agent: agent.to_string(),
        received_ms: now,
        payload,
    };
    let path = dir.join(format!("{id}.json"));
    let json = serde_json::to_string_pretty(&envelope)
        .map_err(|e| AgentError::Io(format!("serialize: {e}")))?;
    std::fs::write(&path, json).map_err(|e| AgentError::Io(format!("write: {e}")))?;

    let delivery = match read_agent(agents_dir, agent).and_then(|r| r.wake) {
        Some(argv) if !argv.is_empty() => match spawn_wake(&argv, &path) {
            Ok(()) => Delivery::Woken,
            Err(e) => {
                eprintln!("companion-hub: wake for '{agent}' failed: {e}");
                Delivery::WakeFailed
            }
        },
        _ => Delivery::Queued,
    };
    Ok((envelope, delivery))
}

/// Spawn the wake argv detached — the hub never waits on an agent run.
fn spawn_wake(argv: &[String], envelope_path: &Path) -> Result<(), String> {
    std::process::Command::new(&argv[0])
        .args(&argv[1..])
        .arg(envelope_path)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .map(|_| ())
        .map_err(|e| e.to_string())
}

/// Pending envelopes for `agent`, oldest first (arrival order), capped.
pub fn list_inbox(inbox_dir: &Path, agent: &str) -> Vec<InboxEnvelope> {
    let Some(dir) = safe_slug(agent).and_then(|a| inbox_dir_for(inbox_dir, a)) else {
        return Vec::new();
    };
    let mut envelopes: Vec<InboxEnvelope> = std::fs::read_dir(dir)
        .into_iter()
        .flatten()
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .filter(|p| p.extension().and_then(|e| e.to_str()) == Some("json"))
        .filter_map(|p| std::fs::read_to_string(p).ok())
        .filter_map(|raw| serde_json::from_str::<InboxEnvelope>(&raw).ok())
        .collect();
    envelopes.sort_by_key(|e| e.received_ms);
    envelopes.truncate(INBOX_LIST_MAX);
    envelopes
}

/// Remove one delivered envelope (the agent's ack).
pub fn ack_inbox(inbox_dir: &Path, agent: &str, id: &str) -> Result<(), AgentError> {
    let agent = safe_slug(agent).ok_or(AgentError::InvalidId)?;
    let id = safe_slug(id).ok_or(AgentError::InvalidId)?;
    let path = inbox_dir_for(inbox_dir, agent)
        .ok_or(AgentError::InvalidId)?
        .join(format!("{id}.json"));
    if !path.exists() {
        return Err(AgentError::NotFound);
    }
    std::fs::remove_file(&path).map_err(|e| AgentError::Io(format!("remove: {e}")))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn temp_dirs(name: &str) -> (PathBuf, PathBuf, PathBuf, PathBuf) {
        let base = std::env::temp_dir().join(format!(
            "companion-hub-agents-{name}-{}-{}",
            std::process::id(),
            now_ms()
        ));
        (
            base.join("agents"),
            base.join("inbox"),
            base.join("live"),
            base.join("artifacts"),
        )
    }

    fn upsert(name: Option<&str>) -> AgentUpsert {
        AgentUpsert {
            name: name.map(String::from),
            emoji: Some("🪽".into()),
            tagline: Some("morning briefs and task triage".into()),
            capabilities: vec!["morning-brief".into()],
            wake: None,
        }
    }

    #[test]
    fn registers_and_preserves_registered_ms() {
        let (agents, _, _, _) = temp_dirs("register");
        let first = write_agent(&agents, "hermes", upsert(Some("Hermes"))).unwrap();
        assert_eq!(first.name, "Hermes");
        std::thread::sleep(std::time::Duration::from_millis(2));
        let second = write_agent(&agents, "hermes", upsert(None)).unwrap();
        assert_eq!(second.registered_ms, first.registered_ms);
        assert!(second.updated_ms > first.updated_ms);
        assert_eq!(second.name, "hermes"); // name defaults to id
        let _ = fs::remove_dir_all(agents.parent().unwrap());
    }

    #[test]
    fn rejects_invalid_agent_ids() {
        let (agents, _, _, _) = temp_dirs("invalid");
        assert_eq!(
            write_agent(&agents, "../x", upsert(None)).unwrap_err(),
            AgentError::InvalidId
        );
    }

    #[test]
    fn liveness_attributes_artifacts_by_project() {
        let (agents, _, live, artifacts) = temp_dirs("liveness");
        fs::create_dir_all(&live).unwrap();
        fs::create_dir_all(&artifacts).unwrap();
        write_agent(&agents, "hermes", upsert(Some("Hermes"))).unwrap();

        fs::write(
            live.join("hermes.json"),
            r#"{"working":"triaging tasks","project":"hermes"}"#,
        )
        .unwrap();
        fs::write(
            artifacts.join("hermes-morning-brief.html"),
            r#"<html><head><title>Brief</title>
               <script type="application/json" id="companion-meta">{"project":"hermes"}</script>
               </head><body></body></html>"#,
        )
        .unwrap();
        fs::write(
            artifacts.join("other.html"),
            r#"<html><head><title>Other</title>
               <script type="application/json" id="companion-meta">{"project":"someone-else"}</script>
               </head><body></body></html>"#,
        )
        .unwrap();

        let info = get_agent_info(&agents, &live, &artifacts, "hermes").unwrap();
        assert_eq!(info.artifact_count, 1);
        assert_eq!(info.working.as_deref(), Some("triaging tasks"));
        assert!(info.last_seen_ms > 0);

        let listed = list_agents(&agents, &live, &artifacts);
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].reg.id, "hermes");
        let _ = fs::remove_dir_all(agents.parent().unwrap());
    }

    #[test]
    fn inbox_queues_lists_and_acks() {
        let (agents, inbox, _, _) = temp_dirs("inbox");
        let (envelope, delivery) = deliver(
            &inbox,
            &agents,
            "hermes",
            serde_json::json!({"kind":"note","text":"push the brief earlier"}),
        )
        .unwrap();
        assert_eq!(delivery, Delivery::Queued); // no registration → no wake

        let pending = list_inbox(&inbox, "hermes");
        assert_eq!(pending.len(), 1);
        assert_eq!(pending[0], envelope);

        ack_inbox(&inbox, "hermes", &envelope.id).unwrap();
        assert!(list_inbox(&inbox, "hermes").is_empty());
        assert_eq!(
            ack_inbox(&inbox, "hermes", &envelope.id).unwrap_err(),
            AgentError::NotFound
        );
        let _ = fs::remove_dir_all(inbox.parent().unwrap());
    }

    #[test]
    fn inbox_wake_spawns_and_write_survives_wake_failure() {
        let (agents, inbox, _, _) = temp_dirs("wake");
        // `true` exists everywhere; the spawn succeeding is all we assert.
        write_agent(
            &agents,
            "waker",
            AgentUpsert {
                name: None,
                emoji: None,
                tagline: None,
                capabilities: vec![],
                wake: Some(vec!["true".into()]),
            },
        )
        .unwrap();
        let (_, delivery) = deliver(&inbox, &agents, "waker", serde_json::json!({})).unwrap();
        assert_eq!(delivery, Delivery::Woken);

        write_agent(
            &agents,
            "broken",
            AgentUpsert {
                name: None,
                emoji: None,
                tagline: None,
                capabilities: vec![],
                wake: Some(vec!["/nonexistent/binary".into()]),
            },
        )
        .unwrap();
        let (env2, delivery2) = deliver(&inbox, &agents, "broken", serde_json::json!({})).unwrap();
        assert_eq!(delivery2, Delivery::WakeFailed);
        // The envelope is still queued despite the failed wake.
        assert_eq!(list_inbox(&inbox, "broken"), vec![env2]);
        let _ = fs::remove_dir_all(inbox.parent().unwrap());
    }
}
