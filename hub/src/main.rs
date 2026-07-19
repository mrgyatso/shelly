//! Shelly Hub — a small self-hosted HTTP server that serves the Shelly
//! live-state + artifacts (the same files the local overlay reads) to the
//! overlay's pull loop and to a same-origin web UI.
//!
//! Self-hosted by design: no accounts, no central service. Auth is one shared
//! bearer token. Clients dial *out* to wherever the user runs this (a public
//! host, a Tailscale IP, a LAN address) — the hub is URL-agnostic.

mod agents;
mod config;
mod data;

use std::sync::Arc;
use std::time::Duration;

use axum::{
    extract::{Path as AxPath, Query, Request, State},
    http::{
        header::{AUTHORIZATION, CONTENT_TYPE},
        StatusCode,
    },
    middleware::Next,
    response::{IntoResponse, Response},
    routing::get,
    Json, Router,
};
use config::Config;
use tower_http::services::{ServeDir, ServeFile};

type Shared = Arc<Config>;

#[tokio::main]
async fn main() {
    let cfg = match Config::load() {
        Ok(c) => Arc::new(c),
        Err(e) => {
            eprintln!("shelly-hub: failed to load config: {e}");
            std::process::exit(1);
        }
    };

    println!(
        "shelly-hub v{} — binding {}:{}",
        env!("CARGO_PKG_VERSION"),
        cfg.bind,
        cfg.port
    );
    println!("  artifacts: {}", cfg.artifacts_dir.display());
    println!("  live:      {}", cfg.live_dir.display());
    println!("  routines:  {}", cfg.routines_dir.display());
    println!("  agents:    {}", cfg.agents_dir.display());
    println!("  inbox:     {}", cfg.inbox_dir.display());
    println!("  web ui:    {}", cfg.webui_dir.display());
    println!("  pair this hub with the overlay:");
    println!("      shelly hub set <this-hub-url> {}", cfg.token);

    // Token-gated API surface. Health stays outside the auth layer so a client
    // can probe reachability before it has a (valid) token.
    let authed = Router::new()
        .route("/live", get(get_live))
        .route("/routines", get(get_routines))
        .route("/routines/:id", get(get_routine).put(put_routine))
        .route("/agents", get(get_agents))
        .route("/agents/:id", get(get_agent).put(put_agent))
        .route("/inbox/:agent", get(get_inbox).post(post_inbox))
        .route("/inbox/:agent/:id", axum::routing::delete(delete_inbox))
        .route("/artifacts", get(get_artifacts))
        .route("/artifacts/:slug", get(get_artifact))
        .layer(axum::middleware::from_fn_with_state(cfg.clone(), auth));

    let api = Router::new().route("/health", get(health)).merge(authed);

    let webui_index = cfg.webui_dir.join("index.html");
    let app = Router::new()
        .nest("/api", api)
        // Static web UI at `/`, falling back to index.html for unknown paths.
        .fallback_service(ServeDir::new(&cfg.webui_dir).fallback(ServeFile::new(webui_index)))
        .with_state(cfg.clone());

    let listener = bind_with_retry(&cfg.bind, cfg.port).await;
    if let Err(e) = axum::serve(listener, app).await {
        eprintln!("shelly-hub: server error: {e}");
        std::process::exit(1);
    }
}

/// Bind, retrying for up to ~5 minutes. A hub pinned to a tailnet IP via
/// SHELLY_HUB_BIND races tailscale0 at boot ("Cannot assign requested
/// address") — that's transient, so wait for the interface instead of dying
/// into systemd's start-limit. Persistent failures still exit non-zero.
async fn bind_with_retry(bind: &str, port: u16) -> tokio::net::TcpListener {
    const RETRY_EVERY: Duration = Duration::from_secs(3);
    const MAX_ATTEMPTS: u32 = 100;
    for attempt in 1..=MAX_ATTEMPTS {
        match tokio::net::TcpListener::bind((bind, port)).await {
            Ok(l) => return l,
            Err(e) if attempt < MAX_ATTEMPTS => {
                if attempt == 1 || attempt % 10 == 0 {
                    eprintln!(
                        "shelly-hub: bind {bind}:{port} failed ({e}); retrying every {}s (attempt {attempt}/{MAX_ATTEMPTS})",
                        RETRY_EVERY.as_secs()
                    );
                }
                tokio::time::sleep(RETRY_EVERY).await;
            }
            Err(e) => {
                eprintln!("shelly-hub: failed to bind port {port}: {e}");
                std::process::exit(1);
            }
        }
    }
    unreachable!("bind loop returns or exits");
}

/// `GET /api/health` — unauthenticated reachability probe.
async fn health() -> Json<serde_json::Value> {
    Json(serde_json::json!({ "ok": true, "version": env!("CARGO_PKG_VERSION") }))
}

/// Bearer-token gate for `/api/*` (except health). Constant-time compare so a
/// wrong token can't be recovered by timing.
async fn auth(State(cfg): State<Shared>, req: Request, next: Next) -> Result<Response, StatusCode> {
    let presented = req
        .headers()
        .get(AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .map(str::trim);

    match presented {
        Some(token) if constant_time_eq(token, &cfg.token) => Ok(next.run(req).await),
        _ => Err(StatusCode::UNAUTHORIZED),
    }
}

fn constant_time_eq(a: &str, b: &str) -> bool {
    let (a, b) = (a.as_bytes(), b.as_bytes());
    if a.len() != b.len() {
        return false;
    }
    a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

#[derive(serde::Deserialize)]
struct LiveQuery {
    project: Option<String>,
}

/// `GET /api/live[?project=<slug>]` — newest (or named) live-state object.
async fn get_live(
    State(cfg): State<Shared>,
    Query(q): Query<LiveQuery>,
) -> Json<serde_json::Value> {
    Json(data::read_live(&cfg.live_dir, q.project.as_deref()))
}

/// `GET /api/routines` — all routine-state objects, newest first.
async fn get_routines(State(cfg): State<Shared>) -> Json<Vec<data::RoutineState>> {
    Json(data::list_routines(&cfg.routines_dir))
}

/// `GET /api/routines/<id>` — one routine-state object.
async fn get_routine(State(cfg): State<Shared>, AxPath(id): AxPath<String>) -> Response {
    match data::read_routine(&cfg.routines_dir, &id) {
        Some(routine) => Json(routine).into_response(),
        None => StatusCode::NOT_FOUND.into_response(),
    }
}

/// `PUT /api/routines/<id>` — upsert one routine-state object.
async fn put_routine(
    State(cfg): State<Shared>,
    AxPath(id): AxPath<String>,
    Json(input): Json<data::RoutineUpsert>,
) -> Response {
    match data::write_routine(&cfg.routines_dir, &id, input) {
        Ok(routine) => Json(routine).into_response(),
        Err(data::WriteRoutineError::InvalidId) => {
            (StatusCode::BAD_REQUEST, "invalid routine id").into_response()
        }
        Err(data::WriteRoutineError::Io(err)) => {
            (StatusCode::INTERNAL_SERVER_ERROR, err).into_response()
        }
    }
}

/// `GET /api/agents` — every registered agent + liveness, freshest first.
async fn get_agents(State(cfg): State<Shared>) -> Json<Vec<agents::AgentInfo>> {
    Json(agents::list_agents(
        &cfg.agents_dir,
        &cfg.live_dir,
        &cfg.artifacts_dir,
    ))
}

/// `GET /api/agents/<id>` — one agent + liveness.
async fn get_agent(State(cfg): State<Shared>, AxPath(id): AxPath<String>) -> Response {
    match agents::get_agent_info(&cfg.agents_dir, &cfg.live_dir, &cfg.artifacts_dir, &id) {
        Some(info) => Json(info).into_response(),
        None => StatusCode::NOT_FOUND.into_response(),
    }
}

/// `PUT /api/agents/<id>` — register or update an agent's identity card.
async fn put_agent(
    State(cfg): State<Shared>,
    AxPath(id): AxPath<String>,
    Json(input): Json<agents::AgentUpsert>,
) -> Response {
    match agents::write_agent(&cfg.agents_dir, &id, input) {
        Ok(reg) => Json(reg).into_response(),
        Err(e) => agent_error(e),
    }
}

/// `POST /api/inbox/<agent>` — queue a reply envelope for an agent and wake it
/// if its registration has a wake command. Returns the stored envelope plus
/// how it was delivered (`woken` | `queued` | `wake_failed`).
async fn post_inbox(
    State(cfg): State<Shared>,
    AxPath(agent): AxPath<String>,
    Json(payload): Json<serde_json::Value>,
) -> Response {
    match agents::deliver(&cfg.inbox_dir, &cfg.agents_dir, &agent, payload) {
        Ok((envelope, delivery)) => Json(serde_json::json!({
            "envelope": envelope,
            "delivery": delivery,
        }))
        .into_response(),
        Err(e) => agent_error(e),
    }
}

/// `GET /api/inbox/<agent>` — pending envelopes, oldest first. For agents on
/// other machines; co-located agents read `inbox/<agent>/` directly.
async fn get_inbox(State(cfg): State<Shared>, AxPath(agent): AxPath<String>) -> Response {
    Json(agents::list_inbox(&cfg.inbox_dir, &agent)).into_response()
}

/// `DELETE /api/inbox/<agent>/<id>` — the agent acks a processed envelope.
async fn delete_inbox(
    State(cfg): State<Shared>,
    AxPath((agent, id)): AxPath<(String, String)>,
) -> Response {
    match agents::ack_inbox(&cfg.inbox_dir, &agent, &id) {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(e) => agent_error(e),
    }
}

fn agent_error(e: agents::AgentError) -> Response {
    match e {
        agents::AgentError::InvalidId => (StatusCode::BAD_REQUEST, "invalid id").into_response(),
        agents::AgentError::NotFound => StatusCode::NOT_FOUND.into_response(),
        agents::AgentError::Io(err) => (StatusCode::INTERNAL_SERVER_ERROR, err).into_response(),
    }
}

/// `GET /api/artifacts` — manifest of all artifacts, newest first.
async fn get_artifacts(State(cfg): State<Shared>) -> Json<Vec<data::ArtifactEntry>> {
    Json(data::list_artifacts(&cfg.artifacts_dir))
}

/// `GET /api/artifacts/<slug>` — the raw artifact HTML.
async fn get_artifact(State(cfg): State<Shared>, AxPath(slug): AxPath<String>) -> Response {
    match data::read_artifact(&cfg.artifacts_dir, &slug) {
        Some(bytes) => ([(CONTENT_TYPE, "text/html; charset=utf-8")], bytes).into_response(),
        None => StatusCode::NOT_FOUND.into_response(),
    }
}
