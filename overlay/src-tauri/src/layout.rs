//! Where panels open. Panels are laid out *after* each reports its fitted size
//! (see `notify_fit`), so the arrangement respects real sizes and never overlaps
//! — unlike a fixed-step cascade, which stacked differently-sized panels on top
//! of each other.
//!
//! Free layout: a right-aligned vertical column, wrapping to a new column on the
//! left when one runs past the bottom of the work area. (Terminal-follow layout —
//! docking the column to the Ghostty window and tracking its moves — is the next
//! step and will live here too.)

use tauri::{AppHandle, LogicalPosition, Manager};

/// Gap from the work-area edge.
const SCREEN_MARGIN: f64 = 16.0;
/// Leave room for the menu bar at the top.
const TOP_MARGIN: f64 = 40.0;
/// Gap between stacked panels.
const GAP: f64 = 12.0;

/// Tracks the stable open order of artifact panels so the column is deterministic
/// (a `HashMap`'s iteration order is not). Managed in Tauri state.
#[derive(Default)]
pub struct LayoutState {
    order: std::sync::Mutex<Vec<String>>,
}

/// Remember a freshly opened panel's label, preserving open order.
pub fn record_open(app: &AppHandle, label: &str) {
    let state = app.state::<LayoutState>();
    let mut order = state.order.lock().unwrap();
    if !order.iter().any(|l| l == label) {
        order.push(label.to_string());
    }
}

/// Re-flow every artifact panel into a right-aligned column. Idempotent: re-running
/// after a panel fits, opens, or closes keeps the same tidy arrangement.
pub fn arrange(app: &AppHandle) {
    let state = app.state::<LayoutState>();
    let labels: Vec<String> = {
        let mut order = state.order.lock().unwrap();
        order.retain(|l| app.get_webview_window(l).is_some());
        order.clone()
    };
    if labels.is_empty() {
        return;
    }

    let Some(mon) = app.primary_monitor().ok().flatten() else {
        return;
    };
    let scale = mon.scale_factor();
    let mon_w = mon.size().width as f64 / scale;
    let mon_h = mon.size().height as f64 / scale;
    let ox = mon.position().x as f64 / scale;
    let oy = mon.position().y as f64 / scale;

    let mut col_right = ox + mon_w - SCREEN_MARGIN;
    let mut y = oy + TOP_MARGIN;
    let mut col_w: f64 = 0.0;

    for label in &labels {
        let Some(win) = app.get_webview_window(label) else {
            continue;
        };
        let (w, h) = match win.outer_size() {
            Ok(s) => (s.width as f64 / scale, s.height as f64 / scale),
            Err(_) => continue,
        };
        // Wrap to a new column on the left once this panel would run off the bottom.
        if y + h > oy + mon_h - SCREEN_MARGIN && y > oy + TOP_MARGIN {
            col_right -= col_w + GAP;
            y = oy + TOP_MARGIN;
            col_w = 0.0;
        }
        let x = (col_right - w).max(ox + SCREEN_MARGIN);
        let _ = win.set_position(LogicalPosition::new(x, y));
        y += h + GAP;
        col_w = col_w.max(w);
    }
}

/// Called by the frontend once a panel has resized to its artifact's fitted size,
/// so the column can be laid out with real dimensions.
#[tauri::command]
pub fn notify_fit(app: AppHandle) {
    arrange(&app);
}
