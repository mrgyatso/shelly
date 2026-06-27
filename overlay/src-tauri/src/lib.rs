mod artifact;
mod artifact_watch;
mod history;
mod hub;
mod layout;
mod live;
mod macos_panel;
mod pty;
mod sessions;
mod tray;
mod windows;

use std::panic::{catch_unwind, AssertUnwindSafe};

use tauri::Manager;

/// Run `f`, containing any panic so it cannot unwind across the Objective-C /
/// CoreFoundation run-loop boundary — which aborts the whole daemon and drops
/// every panel (the repeated SIGABRT crashes). The panic's location + message
/// are already recorded by the hook installed in `run()`; here we just swallow
/// it so one bad artifact can never take the process down.
fn guard(f: impl FnOnce()) {
    let _ = catch_unwind(AssertUnwindSafe(f));
}

/// Append a panic record to a logfile, so the root cause survives even though the
/// hook that launches the daemon throws away its stderr.
fn log_panic(location: &str, msg: &str) {
    use std::io::Write;
    use std::time::{SystemTime, UNIX_EPOCH};
    let ts = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let line = format!("[{ts}] panic at {location}: {msg}\n");
    eprintln!("[overlay] {}", line.trim_end());
    if let Some(home) = std::env::var_os("HOME") {
        let path = std::path::Path::new(&home).join("Library/Logs/companion-overlay.log");
        if let Ok(mut f) = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(path)
        {
            let _ = f.write_all(line.as_bytes());
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Capture every panic's file:line + message before it unwinds; combined with
    // `guard()` at the run-loop boundaries this turns the fatal cross-FFI SIGABRT
    // into a logged, non-fatal event.
    std::panic::set_hook(Box::new(|info| {
        let location = info
            .location()
            .map(|l| format!("{}:{}", l.file(), l.line()))
            .unwrap_or_else(|| "?".to_string());
        let msg = info
            .payload()
            .downcast_ref::<&str>()
            .map(|s| s.to_string())
            .or_else(|| info.payload().downcast_ref::<String>().cloned())
            .unwrap_or_else(|| "<non-string panic>".to_string());
        log_panic(&location, &msg);
    }));

    #[allow(unused_mut)]
    let mut builder = tauri::Builder::default()
        .manage(layout::LayoutState::default())
        .manage(pty::PtyState::default());

    // Single-instance ONLY in release. In a debug build we deliberately skip it so
    // `npm run tauri dev` runs as a SECOND instance ALONGSIDE the installed release
    // — keep your stable app up for real work, iterate on the dev build, and never
    // have to close the whole app to rebuild/test. (Release still forwards a second
    // `companion …` invocation to the running instance, as before.)
    #[cfg(not(debug_assertions))]
    {
        builder = builder
            // single-instance first so a forwarded `companion open …` exits fast.
            .plugin(tauri_plugin_single_instance::init(|app, args, cwd| {
                // This callback fires on the plugin's socket-listener thread, but
                // creating a window (WebviewWindowBuilder::build / NSPanel reclass)
                // MUST happen on the main thread or AppKit aborts and kills the
                // primary process. Hop to the main thread first.
                let handle = app.clone();
                let _ = app.run_on_main_thread(move || {
                    guard(|| {
                        // `companion history` toggles the HUD (a keybind-free trigger,
                        // useful when ⌘8 is swallowed e.g. over remote desktop).
                        if args.iter().any(|a| a == "history") {
                            windows::open_history_window(&handle);
                        } else if args.iter().any(|a| a == "live") {
                            windows::open_live_window(&handle);
                        } else if args.iter().any(|a| a == "board") {
                            windows::open_board_window(&handle);
                        } else if artifact::parse_open_args(&args, Some(&cwd)).is_some() {
                            // `companion open <artifact>` no longer spawns a standalone
                            // window — the Board is the single surface and ingests the
                            // artifact; just bring the shell forward.
                            windows::open_board_window(&handle);
                        } else {
                            windows::raise_all(&handle);
                        }
                    });
                });
            }));
    }

    builder = builder
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_deep_link::init())
        // Native folder picker for "+ New session" (where to spawn `claude`).
        .plugin(tauri_plugin_dialog::init())
        // Lets interactive review artifacts write their compiled prose to the
        // system clipboard via the plugin's JS API (writeText). Only write is
        // permitted in capabilities; we never read the user's clipboard.
        .plugin(tauri_plugin_clipboard_manager::init())
        // Register the overlay as a macOS Login Item so it's already running
        // when the user starts a session — no "first artifact after reboot goes
        // nowhere because the daemon hadn't been launched yet." Idempotent;
        // user can disable via System Settings → General → Login Items.
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .invoke_handler(tauri::generate_handler![
            artifact::read_artifact,
            artifact::artifact_in_scope,
            layout::notify_fit,
            history::list_artifacts,
            history::sweep_artifacts,
            history::reopen_artifact,
            history::resolve_home,
            history::resolve_unit_home,
            live::read_live,
            live::read_all_live,
            live::dismiss_session,
            live::read_unit_names,
            live::set_unit_name,
            live::resolve_home_dir,
            windows::show_board,
            windows::take_board_nav_target,
            pty::spawn_pty,
            pty::write_pty,
            pty::resize_pty,
            pty::close_pty,
            sessions::list_recent_sessions,
            hub::read_live_from_hub,
            hub::hub_config_get,
            hub::hub_config_set,
            hub::hub_test_connection
        ])
        .setup(|app| {
            // Regular activation policy: the Board is a normal app now — it gets a
            // Dock icon and a Cmd-Tab entry, lives on one Space, and the menu bar
            // shows when active.
            //
            // This does NOT make the pill / ghost panels steal terminal focus: that
            // is enforced separately in `macos_panel.rs` by the non-activating-panel
            // treatment (the `NonactivatingPanel` mask + `becomesKeyOnlyIfNeeded` +
            // the private `_setPreventsActivation:` call) — independent of the app's
            // activation policy. So those panels still pop / drag / get clicked
            // without making the app key, while clicking a text input still makes the
            // panel key so the user can type. The earlier `Accessory` (and before it
            // `Prohibited`) choices were about hiding the Dock icon, not about focus.
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Regular);

            // Minimal app + Edit menu so ⌘V/⌘C/⌘X/⌘A/⌘Z route to the focused
            // textarea inside an interactive artifact's iframe. A borderless
            // Accessory-policy app has no main menu by default, so AppKit had no
            // `paste:` key equivalent to dispatch — typing worked (key-window
            // focus is fixed by the CompanionKeyPanel subclass) but paste didn't.
            // The menu stays invisible (Accessory hides the bar); performKeyEquivalent
            // walks the main menu regardless.
            #[cfg(target_os = "macos")]
            {
                use tauri::menu::{Menu, PredefinedMenuItem, Submenu};
                let h = app.handle();
                let app_menu = Submenu::with_items(
                    h,
                    "Companion",
                    true,
                    &[
                        &PredefinedMenuItem::hide(h, None)?,
                        &PredefinedMenuItem::separator(h)?,
                        &PredefinedMenuItem::quit(h, None)?,
                    ],
                )?;
                let edit_menu = Submenu::with_items(
                    h,
                    "Edit",
                    true,
                    &[
                        &PredefinedMenuItem::undo(h, None)?,
                        &PredefinedMenuItem::redo(h, None)?,
                        &PredefinedMenuItem::separator(h)?,
                        &PredefinedMenuItem::cut(h, None)?,
                        &PredefinedMenuItem::copy(h, None)?,
                        &PredefinedMenuItem::paste(h, None)?,
                        &PredefinedMenuItem::select_all(h, None)?,
                    ],
                )?;
                let menu = Menu::with_items(h, &[&app_menu, &edit_menu])?;
                app.set_menu(menu)?;
            }

            // First-launch: this very process may carry `open <path>`.
            // (single-instance only fires for *subsequent* invocations.)
            let args: Vec<String> = std::env::args().collect();
            let cwd = std::env::current_dir()
                .ok()
                .map(|p| p.to_string_lossy().into_owned());
            if args.iter().any(|a| a == "history") {
                let handle = app.handle().clone();
                guard(move || windows::open_history_window(&handle));
            } else if args.iter().any(|a| a == "live") {
                let handle = app.handle().clone();
                guard(move || windows::open_live_window(&handle));
            } else if args.iter().any(|a| a == "board") {
                let handle = app.handle().clone();
                guard(move || windows::open_board_window(&handle));
            } else if artifact::parse_open_args(&args, cwd.as_deref()).is_some() {
                // `companion open <artifact>` brings up the Board (the single
                // surface), never a standalone window. The always-on board open
                // below also covers this; kept explicit for clarity.
                let handle = app.handle().clone();
                guard(move || windows::open_board_window(&handle));
            }

            // Always-on: bring up the Board on every launch, regardless of any
            // artifact/history arg above. The Board is the single primary surface
            // (the live-state data lives in its session cards). Idempotent
            // (open_board_window raises the existing window if it's already up),
            // so the `board` arg path and this can't double-create it.
            {
                let handle = app.handle().clone();
                guard(move || windows::open_board_window(&handle));
            }
            // Background remote-hub pull loop: if `~/.claude/companion/hub.json`
            // points at a hub, download its new artifacts into `remote/` (so the
            // history HUD shows them) and pop the ones that appear after the
            // initial sync. No-op until a hub is configured; re-reads config each
            // tick so `companion hub set …` needs no restart.
            hub::start_pull_loop(app.handle().clone());

            // Runtime deep-link registration (needed in dev / on Linux).
            #[cfg(any(target_os = "linux", debug_assertions))]
            {
                use tauri_plugin_deep_link::DeepLinkExt;
                let _ = app.deep_link().register_all();
            }

            // Global show/hide toggle (⌘0). Registered from Rust, so it needs no
            // capability permission — capabilities only gate frontend IPC. This is
            // the guaranteed escape hatch once the window goes frameless (Q2) and
            // transparent (Q3): even if the chrome mis-paints, ⌘0 always recovers it.
            #[cfg(desktop)]
            {
                use tauri_plugin_global_shortcut::{
                    Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState,
                };
                // ⌘0 = show/hide all panels. ⌘9 = toggle Free ↔ Terminal (dock the
                // column to the focused terminal window and follow it). ⌘8 = open
                // the history HUD (a grid of past artifacts to re-open).
                let toggle = Shortcut::new(Some(Modifiers::SUPER), Code::Digit0);
                let follow = Shortcut::new(Some(Modifiers::SUPER), Code::Digit9);
                let history = Shortcut::new(Some(Modifiers::SUPER), Code::Digit8);
                app.handle().plugin(
                    tauri_plugin_global_shortcut::Builder::new()
                        .with_handler(|app, shortcut, event| {
                            if event.state != ShortcutState::Pressed {
                                return;
                            }
                            if shortcut.matches(Modifiers::SUPER, Code::Digit0) {
                                windows::toggle_all(app);
                            } else if shortcut.matches(Modifiers::SUPER, Code::Digit9) {
                                crate::layout::toggle_mode(app);
                            } else if shortcut.matches(Modifiers::SUPER, Code::Digit8) {
                                windows::open_history_window(app);
                            }
                        })
                        .build(),
                )?;
                app.global_shortcut().register(toggle)?;
                app.global_shortcut().register(follow)?;
                app.global_shortcut().register(history)?;
            }

            // Keep the column docked to the terminal while in Terminal mode.
            #[cfg(target_os = "macos")]
            crate::layout::start_follow_poll(app.handle().clone());

            // Register as a Login Item so the overlay autostarts after every
            // reboot — fixes the "nothing pops after a reboot because the
            // daemon isn't running yet" issue. Only enable when NOT already
            // enabled: calling `enable()` unconditionally re-registers the
            // LaunchAgent on every launch, and macOS posts a "<app> is now
            // allowed to run in the background" notification each time the
            // background-item registration changes — so an unguarded enable
            // spams that banner on every relaunch. Failure must not block the
            // daemon, so we swallow errors (the user can still launch manually).
            #[cfg(desktop)]
            {
                use tauri_plugin_autostart::ManagerExt;
                let autolaunch = app.autolaunch();
                if !autolaunch.is_enabled().unwrap_or(false) {
                    let _ = autolaunch.enable();
                }
            }

            // Menu-bar status item — the always-present native anchor: a
            // glanceable "needs you" count + click-to-open-Board. Failure must
            // not block the daemon.
            if let Err(e) = crate::tray::init_tray(app.handle()) {
                eprintln!("tray init failed: {e}");
            }

            // Native artifact-dir watcher → emits `board:artifacts-changed`. Surfacing
            // otherwise rides only the webview's JS poll, which macOS throttles to
            // minutes when the Board is occluded; a native thread (not throttled) wakes
            // the poll promptly so new artifacts don't surface "late".
            crate::artifact_watch::init(app.handle());

            Ok(())
        });

    // Debug-only MCP bridge for headless verification. Pinned to a unique
    // localhost port (9339) so it never collides with TUICommander's 9223 range;
    // inspect this app via driver_session(port:9339) → read_logs / webview_execute_js.
    #[cfg(debug_assertions)]
    {
        builder = builder.plugin(
            tauri_plugin_mcp_bridge::Builder::new()
                .bind_address("127.0.0.1")
                .base_port(9339)
                .build(),
        );
    }

    builder
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            #[cfg(not(target_os = "macos"))]
            let _ = &app_handle;
            // Guard the whole dispatch: this runs inside a CFRunLoop observer, so a
            // panic that unwound out of here would abort the daemon (see `guard`).
            guard(move || match event {
                // Stay alive as a background daemon: closing the last panel must
                // not quit, so a later `companion open` still forwards here.
                tauri::RunEvent::ExitRequested { api, .. } => {
                    eprintln!("[overlay] ExitRequested (prevented; daemon stays alive)");
                    api.prevent_exit();
                }
                // A panel is about to close (✕ → JS `close()`): restore its
                // original window class BEFORE tao tears it down, so the reclassed
                // NSPanel isn't disposed via the wrong AppKit path (which raises a
                // foreign NSException and aborts the daemon). Do NOT prevent the
                // close — let the teardown proceed on the restored class.
                tauri::RunEvent::WindowEvent {
                    label,
                    event: tauri::WindowEvent::CloseRequested { .. },
                    ..
                } => {
                    if let Some(win) = app_handle.get_webview_window(&label) {
                        crate::macos_panel::restore_original_class(&win);
                    }
                }
                // A panel moved. If it's a genuine user drag (the panel is visible
                // and we aren't mid-move ourselves), pin it so future re-flows leave
                // it where the user put it.
                tauri::RunEvent::WindowEvent {
                    label,
                    event: tauri::WindowEvent::Moved(_),
                    ..
                } => {
                    if let Some(win) = app_handle.get_webview_window(&label) {
                        if win.is_visible().unwrap_or(false)
                            && !crate::layout::is_moving(app_handle, &label)
                        {
                            // Pin where the user dropped it, but clamp (debounced)
                            // so the top can't settle under the menu bar and become
                            // ungrabbable.
                            crate::layout::pin_and_clamp(app_handle, &label);
                        }
                    }
                }
                // A panel closed (✕): re-flow the remaining ones so no gap is left.
                tauri::RunEvent::WindowEvent {
                    label,
                    event: tauri::WindowEvent::Destroyed,
                    ..
                } => {
                    eprintln!(
                        "[overlay] window '{label}' destroyed; {} remain",
                        app_handle.webview_windows().len()
                    );
                    // Re-flow the survivors on the next main-thread tick (deferred to
                    // avoid re-entrant window ops during the destroy dispatch).
                    let handle = app_handle.clone();
                    let _ = app_handle.run_on_main_thread(move || {
                        crate::layout::arrange(&handle, true);
                    });
                }
                // macOS Finder / `open file.html` / `companion://` URL handler.
                #[cfg(target_os = "macos")]
                tauri::RunEvent::Opened { urls } => {
                    for u in &urls {
                        let path = if u.scheme() == "file" {
                            u.to_file_path()
                                .ok()
                                .map(|p| p.to_string_lossy().into_owned())
                        } else {
                            artifact::parse_open_args(&["x".to_string(), u.to_string()], None)
                        };
                        // A Finder open / `companion://` URL surfaces the Board
                        // (the single surface), never a standalone artifact window.
                        if path.is_some() {
                            windows::open_board_window(app_handle);
                        }
                    }
                }
                // Dock-icon click after the Board was minimized or hidden. tao
                // delivers Reopen; with no handler the click was silently dropped,
                // forcing a quit+reopen. unminimize() is required — show() alone
                // only un-hides, it does NOT deminiaturize a window minimized via
                // the yellow button / Cmd-M.
                #[cfg(target_os = "macos")]
                tauri::RunEvent::Reopen { .. } => {
                    if let Some(win) = app_handle.get_webview_window(windows::BOARD_LABEL) {
                        let _ = win.unminimize();
                        let _ = win.show();
                        let _ = win.set_focus();
                    } else {
                        windows::open_board_window(app_handle);
                    }
                }
                _ => {}
            });
        });
}
