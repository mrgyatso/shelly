//! Companion Hub — a small self-hosted HTTP server that serves the Companion
//! live-state + artifacts (the same files the local overlay reads) to the
//! overlay's pull loop and to a same-origin web UI.
//!
//! Self-hosted by design: no accounts, no central service. Auth is one shared
//! bearer token. Clients dial *out* to wherever the user runs this (a public
//! host, a Tailscale IP, a LAN address) — the hub is URL-agnostic.

mod config;
mod data;

use std::sync::Arc;

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
            eprintln!("companion-hub: failed to load config: {e}");
            std::process::exit(1);
        }
    };

    println!(
        "companion-hub v{} — binding 0.0.0.0:{}",
        env!("CARGO_PKG_VERSION"),
        cfg.port
    );
    println!("  artifacts: {}", cfg.artifacts_dir.display());
    println!("  live:      {}", cfg.live_dir.display());
    println!("  web ui:    {}", cfg.webui_dir.display());
    println!("  pair this hub with the overlay:");
    println!("      companion hub set <this-hub-url> {}", cfg.token);

    // Token-gated API surface. Health stays outside the auth layer so a client
    // can probe reachability before it has a (valid) token.
    let authed = Router::new()
        .route("/live", get(get_live))
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

    let listener = match tokio::net::TcpListener::bind(("0.0.0.0", cfg.port)).await {
        Ok(l) => l,
        Err(e) => {
            eprintln!("companion-hub: failed to bind port {}: {e}", cfg.port);
            std::process::exit(1);
        }
    };
    if let Err(e) = axum::serve(listener, app).await {
        eprintln!("companion-hub: server error: {e}");
        std::process::exit(1);
    }
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
