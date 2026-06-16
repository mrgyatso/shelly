//! Menu-bar status item — the native, always-present anchor for Companion.
//!
//! Shows a menu-bar icon plus a glanceable "needs you" count (the number of live
//! agents whose next step is a decision/blocker). Left-click opens the Board;
//! right-click shows a small menu (Open Board / Quit). The count refreshes on a
//! lightweight background poll of the same `live/<slug>.json` files the Board
//! reads — so it's accurate without the per-turn nudge hook we removed.
//!
//! macOS note: NSStatusItem mutations must happen on the main thread, so the
//! poll thread hops back via `run_on_main_thread` before touching the title.

use std::time::{Duration, SystemTime, UNIX_EPOCH};

use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle,
};

const TRAY_ID: &str = "companion-main";
/// A source counts as live while its state file was touched this recently.
const LIVENESS_MS: u64 = 30 * 60 * 1000;
/// How often the menu-bar count refreshes.
const POLL: Duration = Duration::from_secs(4);

/// Build the status item and start its count poll. Call once from `setup`.
pub fn init_tray(app: &AppHandle) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, "open_board", "Open Board", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit Companion", true, None::<&str>)?;
    let sep = PredefinedMenuItem::separator(app)?;
    let menu = Menu::with_items(app, &[&open, &sep, &quit])?;

    let mut builder = TrayIconBuilder::with_id(TRAY_ID)
        .menu(&menu)
        // Left-click is our shortcut to the Board; the menu is right-click only.
        .show_menu_on_left_click(false)
        .tooltip("Companion")
        .on_menu_event(|app, event| match event.id().as_ref() {
            "open_board" => crate::windows::open_board_window(app),
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                crate::windows::open_board_window(tray.app_handle());
            }
        });

    // The app icon, rendered as a template so macOS tints it for the menu bar
    // (adapts to light/dark + the system accent). A dedicated monochrome glyph
    // would read cleaner — tracked as polish.
    if let Some(icon) = app.default_window_icon().cloned() {
        builder = builder.icon(icon).icon_as_template(true);
    }

    builder.build(app)?;
    refresh_now(app);
    spawn_poll(app.clone());
    Ok(())
}

/// Recompute the count and apply it to the status item (must run on main thread).
fn refresh_now(app: &AppHandle) {
    if let Some(tray) = app.tray_by_id(TRAY_ID) {
        let n = needs_you_count();
        let _ = tray.set_title(if n > 0 { Some(n.to_string()) } else { None });
    }
}

/// Poll the live dir in the background; push title updates onto the main thread.
fn spawn_poll(app: AppHandle) {
    std::thread::spawn(move || loop {
        std::thread::sleep(POLL);
        let app = app.clone();
        let _ = app.clone().run_on_main_thread(move || refresh_now(&app));
    });
}

/// Live agents whose first `next` step is a decision or a blocker — i.e. the ones
/// actually waiting on the user. Mirrors the Board's "needs review" signal.
fn needs_you_count() -> usize {
    let now = now_ms();
    crate::live::read_all_live()
        .iter()
        .filter(|s| {
            let v: serde_json::Value = match serde_json::from_str(&s.json) {
                Ok(v) => v,
                Err(_) => return false,
            };
            // Live = touched within the window (absent updated_ms ⇒ treat as live).
            let live = v
                .get("updated_ms")
                .and_then(|x| x.as_u64())
                .is_none_or(|u| now.saturating_sub(u) < LIVENESS_MS);
            if !live {
                return false;
            }
            let kind = v
                .get("next")
                .and_then(|n| n.as_array())
                .and_then(|a| a.first())
                .and_then(|item| item.get("kind"))
                .and_then(|k| k.as_str());
            matches!(kind, Some("decision") | Some("blocked"))
        })
        .count()
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}
