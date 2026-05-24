//! Runtime creation of one floating panel per artifact.
//!
//! Each artifact gets its own [`WebviewWindow`], reclassed to a non-activating
//! NSPanel (see [`crate::macos_panel`]) so several can be up at once — each
//! dragged, resized, and closed independently, none stealing terminal focus.
//! Windows are keyed by a deterministic label derived from the artifact path,
//! so re-opening the same file (e.g. Claude rewrote it) refreshes the existing
//! panel in place instead of spawning a duplicate.

use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};

use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};

/// Initial panel size before the artifact reports its own fit size.
const PANEL_W: f64 = 460.0;
const PANEL_H: f64 = 640.0;
const MIN_W: f64 = 320.0;
const MIN_H: f64 = 120.0;
/// Label prefix marking a window as an artifact panel.
const LABEL_PREFIX: &str = "art_";

/// Deterministic, label-safe id for an artifact path. `DefaultHasher::new()` is
/// seedless, so the same path maps to the same label for the life of the process
/// — which is what lets a forwarded `companion open <same file>` find the panel
/// it already opened instead of creating a second one.
fn label_for(path: &str) -> String {
    let mut h = DefaultHasher::new();
    path.hash(&mut h);
    format!("{LABEL_PREFIX}{:016x}", h.finish())
}

/// Open — or, if already open, refresh + raise — a floating panel for `path`.
pub fn open_artifact_window(app: &AppHandle, path: String) {
    let label = label_for(&path);

    // Already open: re-load (cache-busts) in place and raise without activating.
    // emit_to (not emit) so only THIS panel reloads — emit would broadcast the
    // path to every panel and make them all switch to it.
    if let Some(win) = app.get_webview_window(&label) {
        let _ = win.emit_to(win.label(), "open-artifact", &path);
        crate::macos_panel::order_front_without_activating(&win);
        return;
    }

    // Inject the artifact path so the new window knows what to load on boot,
    // race-free (no IPC round-trip). serde_json yields a safe JS string literal.
    let init = format!(
        "window.__ARTIFACT_PATH__ = {};",
        serde_json::to_string(&path).unwrap_or_else(|_| "\"\"".into())
    );

    let win = match WebviewWindowBuilder::new(app, &label, WebviewUrl::App("index.html".into()))
        .title("Companion Overlay")
        .inner_size(PANEL_W, PANEL_H)
        .min_inner_size(MIN_W, MIN_H)
        .decorations(false)
        .transparent(true)
        .resizable(true)
        .shadow(true)
        .always_on_top(true)
        // Stay hidden until we've reclassed it to a panel + placed it, so it
        // never flashes as a regular activating window.
        .visible(false)
        .initialization_script(init.as_str())
        .build()
    {
        Ok(w) => w,
        Err(e) => {
            eprintln!("[overlay] failed to create panel for {path}: {e}");
            return;
        }
    };

    // Reclass to a non-activating NSPanel BEFORE it becomes visible.
    crate::macos_panel::make_nonactivating_panel(&win);
    // Place it in the column. The size here is the pre-fit default; the frontend
    // re-triggers arrange() via notify_fit once it knows the artifact's real size.
    crate::layout::record_open(app, &label);
    crate::layout::arrange(app);
    crate::macos_panel::order_front_without_activating(&win);
}

/// Raise every panel without activating (the no-arg `companion` invocation).
pub fn raise_all(app: &AppHandle) {
    for win in app.webview_windows().values() {
        crate::macos_panel::order_front_without_activating(win);
    }
}

/// Global ⌘0 toggle: if any panel is visible, hide them all; otherwise show all.
pub fn toggle_all(app: &AppHandle) {
    let wins = app.webview_windows();
    let any_visible = wins.values().any(|w| w.is_visible().unwrap_or(false));
    for win in wins.values() {
        if any_visible {
            let _ = win.hide();
        } else {
            crate::macos_panel::order_front_without_activating(win);
        }
    }
}
