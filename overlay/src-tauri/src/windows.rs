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
/// The single history HUD window. Fixed (not content-hashed) so ⌘8 always
/// finds the one instance to toggle.
pub const HISTORY_LABEL: &str = "hist_main";
/// The single always-on live surface window. Fixed label so `companion live`
/// always finds the one instance to create-or-raise.
pub const LIVE_LABEL: &str = "live_main";
/// The single Board window — the multi-agent steering canvas (grid of artifact
/// tiles). Fixed label so `companion board` always finds the one instance to
/// create-or-raise. P0: a new, isolated surface that does not replace the
/// floating one-off panels yet.
pub const BOARD_LABEL: &str = "board_main";

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
    // Animate the existing panels shifting to make room; the new window is still
    // hidden here, so `apply_moves` snaps it into its slot before we reveal it.
    crate::layout::arrange(app, true);
    crate::macos_panel::order_front_without_activating(&win);
}

/// Open — or toggle — the single history HUD window. Centered and larger than an
/// artifact panel, it's a mouse-driven picker rather than a content panel, so it
/// is deliberately left OUT of the column layout: we never call `record_open`,
/// which is the only thing `layout::arrange` iterates, so it's auto-excluded.
pub fn open_history_window(app: &AppHandle) {
    // Already built: toggle visibility (⌘8 acts as show/hide).
    if let Some(win) = app.get_webview_window(HISTORY_LABEL) {
        if win.is_visible().unwrap_or(false) {
            let _ = win.hide();
        } else {
            crate::macos_panel::order_front_without_activating(&win);
        }
        return;
    }

    let win =
        match WebviewWindowBuilder::new(app, HISTORY_LABEL, WebviewUrl::App("index.html".into()))
            .title("Companion History")
            .inner_size(900.0, 640.0)
            .min_inner_size(560.0, 360.0)
            .decorations(false)
            .transparent(true)
            .resizable(true)
            .shadow(true)
            .always_on_top(true)
            .center()
            .visible(false)
            .initialization_script("window.__HISTORY_MODE__ = true;")
            .build()
        {
            Ok(w) => w,
            Err(e) => {
                eprintln!("[overlay] failed to create history window: {e}");
                return;
            }
        };

    // Same non-activating float as artifact panels (also restores cleanly on
    // close via the shared CloseRequested handler in lib.rs). No record_open /
    // arrange — the HUD is centered, not part of the column.
    crate::macos_panel::make_nonactivating_panel(&win);
    crate::macos_panel::order_front_without_activating(&win);
}

/// Open — or, if already up, raise — the single always-on live surface. Like the
/// HUD it's deliberately left OUT of the column layout (no `record_open`): it's a
/// persistent state pane the user parks where they like, not a content panel that
/// re-flows. It updates in place by polling `read_live`, so re-invoking this just
/// re-reveals the existing window rather than refreshing it.
pub fn open_live_window(app: &AppHandle) {
    if let Some(win) = app.get_webview_window(LIVE_LABEL) {
        crate::macos_panel::order_front_without_activating(&win);
        return;
    }

    let win = match WebviewWindowBuilder::new(app, LIVE_LABEL, WebviewUrl::App("index.html".into()))
        .title("Companion Live")
        .inner_size(440.0, 560.0)
        .min_inner_size(320.0, 200.0)
        .decorations(false)
        .transparent(true)
        .resizable(true)
        .shadow(true)
        .always_on_top(true)
        .visible(false)
        .initialization_script("window.__LIVE_MODE__ = true;")
        .build()
    {
        Ok(w) => w,
        Err(e) => {
            eprintln!("[overlay] failed to create live window: {e}");
            return;
        }
    };

    crate::macos_panel::make_nonactivating_panel(&win);
    crate::macos_panel::order_front_without_activating(&win);
}

/// Open — or, if already up, raise — the single Board window. Like the HUD and
/// live surface it's deliberately left OUT of the column layout (no
/// `record_open`): the Board does its own internal grid layout. Larger than an
/// artifact panel to host a grid of tiles. Re-invoking just re-reveals the
/// existing window without rebuilding it.
pub fn open_board_window(app: &AppHandle) {
    if let Some(win) = app.get_webview_window(BOARD_LABEL) {
        crate::macos_panel::order_front_without_activating(&win);
        return;
    }

    let win =
        match WebviewWindowBuilder::new(app, BOARD_LABEL, WebviewUrl::App("index.html".into()))
            .title("Companion Board")
            .inner_size(1000.0, 700.0)
            .min_inner_size(560.0, 400.0)
            .decorations(false)
            .transparent(true)
            .resizable(true)
            .shadow(true)
            .always_on_top(true)
            .center()
            .visible(false)
            .initialization_script("window.__BOARD_MODE__ = true;")
            .build()
        {
            Ok(w) => w,
            Err(e) => {
                eprintln!("[overlay] failed to create board window: {e}");
                return;
            }
        };

    crate::macos_panel::make_nonactivating_panel(&win);
    crate::macos_panel::order_front_without_activating(&win);
}

/// Raise every panel without activating (the no-arg `companion` invocation).
/// The HUD and live surface are excluded — each is driven by its own trigger,
/// never swept up with the artifact panels.
pub fn raise_all(app: &AppHandle) {
    for win in app.webview_windows().values() {
        if win.label() == HISTORY_LABEL || win.label() == LIVE_LABEL || win.label() == BOARD_LABEL {
            continue;
        }
        crate::macos_panel::order_front_without_activating(win);
    }
}

/// Global ⌘0 toggle: if any panel is visible, hide them all; otherwise show all.
/// The HUD is excluded so ⌘0 never hides/shows it alongside the artifact panels.
pub fn toggle_all(app: &AppHandle) {
    let wins = app.webview_windows();
    let panels = || {
        wins.values().filter(|w| {
            w.label() != HISTORY_LABEL && w.label() != LIVE_LABEL && w.label() != BOARD_LABEL
        })
    };
    let any_visible = panels().any(|w| w.is_visible().unwrap_or(false));
    for win in panels() {
        if any_visible {
            let _ = win.hide();
        } else {
            crate::macos_panel::order_front_without_activating(win);
        }
    }
}
