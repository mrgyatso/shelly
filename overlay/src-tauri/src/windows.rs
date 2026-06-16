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
use std::sync::Mutex;

use tauri::{
    AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, WebviewUrl, WebviewWindow,
    WebviewWindowBuilder,
};

/// The Board's pre-fullscreen frame (physical px), saved so the fullscreen
/// toggle can restore the window to exactly where the user had it. `None` =
/// currently windowed.
static BOARD_PRIOR_FRAME: Mutex<Option<(PhysicalPosition<i32>, PhysicalSize<u32>)>> =
    Mutex::new(None);

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
/// The menu-bar popover — a small roster panel dropped from the status item.
/// Fixed label so the tray click always toggles the one instance.
pub const POPOVER_LABEL: &str = "popover_main";
const POPOVER_W: f64 = 340.0;
const POPOVER_H: f64 = 460.0;

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

/// Frontend-callable wrapper to open the History HUD — used by the Board's
/// "View all in History →" affordance (a capped L2 session links the rest here).
#[tauri::command]
pub fn open_history(app: AppHandle) {
    open_history_window(&app);
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
    // The Board absorbs the live surface: its per-agent panes already show every
    // agent's live-state header, so the separate always-on `live_main` window
    // would just double-show it. Hide it (not close — the daemon keeps writing
    // its files; the Board reads the same data) whenever the Board comes up.
    if let Some(live) = app.get_webview_window(LIVE_LABEL) {
        let _ = live.hide();
    }

    if let Some(win) = app.get_webview_window(BOARD_LABEL) {
        // Focal surface: show + focus (activates the app + makes it key) so its
        // keyboard nav works — not the ghost-panel order-front.
        let _ = win.show();
        let _ = win.set_focus();
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
            // The Board is a normal app window now: it layers like any other window
            // (can be covered, click-outside backgrounds it), NOT pinned above all.
            .always_on_top(false)
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

    // Focal "Board = app window" treatment (key-capable, activating) so spatial
    // keyboard nav works — NOT the non-activating ghost-panel treatment.
    crate::macos_panel::make_board_window(&win);
    let _ = win.show();
    let _ = win.set_focus();
}

/// Open the Board from another window (e.g. a popover row click). A thin command
/// wrapper around [`open_board_window`] so the frontend can summon the focal
/// surface.
#[tauri::command]
pub fn show_board(app: AppHandle) {
    open_board_window(&app);
}

/// Toggle the menu-bar popover — the lightweight roster glance summoned from the
/// status item. It is a key-capable window (so it dismisses on blur, native
/// menu-bar behaviour) created lazily on first open and shown/hidden thereafter.
/// Positioned under the menu bar (top-right for now; icon-precise alignment TBD).
pub fn toggle_popover(app: &AppHandle) {
    if let Some(win) = app.get_webview_window(POPOVER_LABEL) {
        if win.is_visible().unwrap_or(false) {
            let _ = win.hide();
        } else {
            position_popover(&win);
            let _ = win.emit("popover:refresh", ());
            let _ = win.show();
            let _ = win.set_focus();
        }
        return;
    }

    let win =
        match WebviewWindowBuilder::new(app, POPOVER_LABEL, WebviewUrl::App("index.html".into()))
            .title("Companion")
            .inner_size(POPOVER_W, POPOVER_H)
            .decorations(false)
            .transparent(true)
            .resizable(false)
            .shadow(true)
            .always_on_top(true)
            .visible(false)
            .initialization_script("window.__POPOVER_MODE__ = true;")
            .build()
        {
            Ok(w) => w,
            Err(e) => {
                eprintln!("[overlay] failed to create popover window: {e}");
                return;
            }
        };

    // Dismiss on blur — clicking anywhere outside (the terminal, the Board) hides
    // the popover, the way a native menu-bar dropdown behaves.
    let handle = app.clone();
    win.on_window_event(move |event| {
        if let tauri::WindowEvent::Focused(false) = event {
            if let Some(w) = handle.get_webview_window(POPOVER_LABEL) {
                let _ = w.hide();
            }
        }
    });

    // Key-capable + activating so it can take focus (and thus blur to dismiss).
    // Clicking the status item is an explicit gesture, so brief activation is
    // expected — this is NOT the non-activating ghost-panel treatment.
    crate::macos_panel::make_board_window(&win);
    position_popover(&win);
    let _ = win.show();
    let _ = win.set_focus();
}

/// Park the popover at the top-right of the primary monitor, just under the menu
/// bar. (Icon-precise alignment from the tray rect is a follow-up.)
fn position_popover(win: &WebviewWindow) {
    if let Ok(Some(mon)) = win.primary_monitor() {
        let pos = mon.position();
        let size = mon.size();
        let scale = mon.scale_factor();
        let w = (POPOVER_W * scale).round() as i32;
        let margin = (10.0 * scale).round() as i32;
        let menubar = (38.0 * scale).round() as i32;
        let x = pos.x + size.width as i32 - w - margin;
        let y = pos.y + menubar;
        let _ = win.set_position(PhysicalPosition::new(x, y));
    }
}

/// Toggle the Board between windowed and "maximized to its current monitor".
///
/// We deliberately do NOT use native macOS fullscreen (`set_fullscreen(true)`):
/// that forces a Space switch and activates the app, which would steal terminal
/// focus from the non-activating Board panel. Instead we resize/position the
/// window to fill the monitor it's currently on (saving the prior frame to
/// restore on toggle-off), which keeps the panel non-activating. Returns the new
/// state (`true` = now full-screen) so the frontend can update its toggle label.
#[tauri::command]
pub fn set_board_fullscreen(app: AppHandle, on: bool) -> bool {
    let win = match app.get_webview_window(BOARD_LABEL) {
        Some(w) => w,
        None => return false,
    };
    let mut prior = match BOARD_PRIOR_FRAME.lock() {
        Ok(g) => g,
        Err(_) => return false,
    };

    if on {
        // Already full-screen — nothing to do.
        if prior.is_some() {
            return true;
        }
        let monitor = match win.current_monitor() {
            Ok(Some(m)) => m,
            _ => return false,
        };
        // Save the windowed frame (physical px) so we can put it back exactly.
        if let (Ok(pos), Ok(size)) = (win.outer_position(), win.inner_size()) {
            *prior = Some((pos, size));
        }
        // current_monitor() returns physical px, which is exactly what the
        // Physical* setters consume — no scale-factor math needed.
        let _ = win.set_position(*monitor.position());
        let _ = win.set_size(*monitor.size());
        crate::macos_panel::order_front_without_activating(&win);
        true
    } else {
        if let Some((pos, size)) = prior.take() {
            let _ = win.set_position(pos);
            let _ = win.set_size(size);
        }
        crate::macos_panel::order_front_without_activating(&win);
        false
    }
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
